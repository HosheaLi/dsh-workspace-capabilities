/**
 * MCP 工具可见性屏蔽。
 *
 * 语义是**工具可见性**（`ctx.tools.restrict({ deny })`），不是进程启停：MCP 服务器
 * 照常启动、照常占内存，只是工具不进该 agent 的 schema。好处是只影响当前工作区
 * 会话，不连累其他会话，也不需要重启；省下的是每轮固定的 schema token。
 *
 * 两个必须遵守的硬约束：
 *  1. `restrict()` **必须在 scoped context（`agent.ctx`）里调用**，且只 deny
 *     **当前已注册**的工具名 —— 未知名直接抛错，离线 server 零工具时跳过；
 *  2. `restrict()` 会**同步** emit `tools/change`（它走 `layers.effect` 且没传
 *     `notify:false`）。若在 change 监听里无条件重注册，就会形成同步递归 →
 *     栈溢出 → 整个 dsh 进程卡死。必须复刻三段式防护：**哨兵 / 集合比较 /
 *     先删条目再 dispose**。
 *
 * 时机是**两步而不是一步**：MCP 工具由 `dsh-mcp-client` 异步注册（`listTools`
 * 有网络往返），只做一次 deny 会漏掉重连/迟到注册的工具，所以还要在
 * `tools/change` 上持续补偿。
 *
 * @module dsh-workspace-scope/mcp
 */

/** MCP 工具名形如 `mcp__<serverName>__<rawName>`。 */
const MCP_TOOL_PREFIX = 'mcp__';

/**
 * 从工具名解析出 MCP 服务器名。
 *
 * 名字形如 `mcp__<serverName>__<rawName>`，但**不能靠取第一段来反解**：官方
 * `SERVER_NAME_PATTERN`（`/^[A-Za-z0-9_-]{1,32}$/`）允许 serverName 本身包含 `__`，
 * 于是 `mcp__my__server__tool` 会被解析成 `my`，配置里的 `my__server` 匹配不上 →
 * deny 名单为空 → 开关静默失效（官方也明确说明 public name 不应被反解）。
 *
 * 因此优先用**已知服务器名**（来自配置文件的 `mcp` 段）做最长前缀匹配，只在没有
 * 候选可比时退化为取第一段。
 * @param name - 工具名。
 * @param knownServers - 已知服务器名集合；省略时退化为按 `__` 切第一段。
 * @returns 服务器名；不是 MCP 工具时返回 `undefined`。
 */
export function mcpServerOf(name, knownServers) {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  if (knownServers !== undefined) {
    let best;
    for (const server of knownServers) {
      if (typeof server !== 'string' || server === '') continue;
      if (!name.startsWith(`${MCP_TOOL_PREFIX}${server}__`)) continue;
      if (best === undefined || server.length > best.length) best = server;
    }
    if (best !== undefined) return best;
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf('__');
  if (at <= 0) return undefined;
  return rest.slice(0, at);
}

/**
 * 从工具 schema 列表推导出全部 MCP 服务器名。
 * @param schemas - `ctx.tools.schemas()` 的结果（元素含 `name`）。
 * @param knownServers - 已知服务器名集合，见 {@link mcpServerOf}。
 * @returns 去重后的服务器名数组（按码点序）。
 */
export function mcpServersOf(schemas, knownServers) {
  const servers = new Set();
  for (const schema of schemas ?? []) {
    const server = mcpServerOf(schema?.name, knownServers);
    if (server !== undefined) servers.add(server);
  }
  return [...servers].sort();
}

/**
 * 计算某个 agent 当前应当被 deny 的**精确**工具名。
 *
 * 只返回**此刻已注册**的名字：`tools.restrict` 对未知名直接抛错，所以离线
 * 服务器（零工具）在这里被自然跳过。
 * @param schemas - `ctx.tools.schemas()` 的结果。
 * @param isServerEnabled - `(serverName) => boolean`。
 * @param knownServers - 已知服务器名集合，见 {@link mcpServerOf}。
 * @returns 排好序的 deny 名单。
 */
export function denyNamesFor(schemas, isServerEnabled, knownServers) {
  const deny = [];
  for (const schema of schemas ?? []) {
    const name = schema?.name;
    const server = mcpServerOf(name, knownServers);
    if (server === undefined) continue;
    if (isServerEnabled(server) === false) deny.push(name);
  }
  return deny.sort();
}

/** 两个 deny 名单是否逐项相同。 */
function sameDeny(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * 创建三段式防护 + 代际补偿的 restrict 施加器。
 *
 * 除三段式防护外多一层**代际补偿**：`computeDeny` 要读盘（async），await 期间可能
 * 又有工具注册进来；只在 await 前后比对代际，变了就重算，避免"迟到注册的工具被
 * 漏 deny 且不报错"。代际由 {@link McpRestrictor#noteChange} 在 `tools/change` 时推进。
 *
 * @param options - 依赖。
 * @param options.denyNamesFor - `async (agent, scopedTools) => string[]`，按 agent 的 cwd 求 deny 名单；
 *   `scopedTools` 是该 agent 作用域里的 tools 服务，用它读全局工具表可避开插件 ctx 的
 *   active 状态（HMR 重载窗口）。
 * @param options.logger - 日志器。
 * @returns `{ apply, noteChange, forget, disposeAll }`。
 */
export function createMcpRestrictor({ denyNamesFor: computeDeny, logger }) {
  /**
   * agent.id → 在途的施加任务。**存 Promise 而不是布尔值**：调用方（尤其是
   * `agent/created`）要能 await 到限制真正落地；只存标志时第二次调用会立即返回，
   * 把"还在读盘"误当成"已经限制完"。
   */
  const applying = new Map();
  /** agent.id → { deny, disposer }：当前生效的限制层。 */
  const active = new Map();
  /** 工具面变化的代际计数。 */
  let generation = 0;

  /**
   * 施加/更新一个 agent 的 MCP 限制。
   *
   * 同一 agent 的重入返回**同一个在途 Promise**，不会重复计算，也不会让等待方
   * 提前放行。`tools.restrict` 会同步 emit `tools/change`，其处理器可能再次调用
   * 本函数；那条路径只是拿回同一个 Promise（调用方通常 `void` 掉），不会死锁。
   *
   * @param agent - 目标 agent。
   * @returns 本次（或已合并的）施加完成 Promise；agent 为空时立即完成。
   */
  function apply(agent) {
    if (agent === undefined || agent === null) return Promise.resolve();
    const id = agent.id;
    const inFlight = applying.get(id);
    if (inFlight !== undefined) return inFlight; // ① 哨兵：同步重入 / 并发调用合并
    let task;
    task = (async () => {
      try {
        const scopedTools = agent.ctx?.get?.('tools');
        if (scopedTools === undefined) return;
        for (;;) {
          const at = generation;
          const deny = await computeDeny(agent, scopedTools);
          if (at !== generation) continue; // await 期间工具面变了：重算
          const current = active.get(id);
          if (current !== undefined && sameDeny(current.deny, deny)) return; // ② 集合比较：没变就不动
          if (current !== undefined) {
            active.delete(id); // ③ 先删条目，再 dispose（dispose 会同步 emit tools/change）
            try {
              current.disposer();
            } catch (error) {
              logger?.warn?.(`workspace-scope: 撤销旧 MCP 限制失败：${String(error?.message ?? error)}`);
            }
          }
          if (deny.length > 0) active.set(id, { deny, disposer: scopedTools.restrict({ deny }) });
          return;
        }
      } catch (error) {
        // 未知名等异常不该拖垮插件树：记一条 warn，等下一次 tools/change 再补偿。
        logger?.warn?.(`workspace-scope: MCP 屏蔽失败（agent ${String(id)}）：${String(error?.message ?? error)}`);
      } finally {
        if (applying.get(id) === task) applying.delete(id);
      }
    })();
    applying.set(id, task);
    return task;
  }

  return {
    /** 按 agent 的当前 cwd 施加/更新 deny。 */
    apply,

    /** `tools/change` 时推进代际：让在途的 apply 重算，而不是被哨兵静静吞掉。 */
    noteChange() {
      generation += 1;
    },

    /** agent 销毁时清账（限制层随 agent fiber 一起消失，这里只清本插件的记账）。 */
    forget(agentId) {
      active.delete(agentId);
      applying.delete(agentId);
    },

    /** 插件卸载/HMR 时显式撤销全部限制（agent 层注册不随插件 fiber 自动销毁）。 */
    disposeAll() {
      for (const { disposer } of active.values()) {
        try {
          disposer();
        } catch (error) {
          logger?.warn?.(`workspace-scope: 卸载时撤销 MCP 限制失败：${String(error?.message ?? error)}`);
        }
      }
      active.clear();
      applying.clear();
    },
  };
}
