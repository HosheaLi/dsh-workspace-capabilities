/**
 * MCP 服务器**提示词段**遮蔽 —— 与 {@link ./mcp.js} 的工具屏蔽互补。
 *
 * 为什么需要这一层：`dsh-mcp-client` 在 **host 全局层**注册两样东西 ——
 * `mcp__<server>__*` 工具（可被 `tools.restrict` deny）和一条
 * `mcp:<server>` 系统提示段（server instructions，只能靠作用域遮蔽）。只 deny
 * 工具时，提示词里的服务器说明仍在每个工作区注入，这就是残余的上下文噪音。
 *
 * 机制：`systemPrompt.section()` 的注册归属**调用方作用域**（Cordis 的
 * `createTraceable` 会把方法内的 `this.ctx` 换成调用方 ctx），而
 * `dsh-system-prompt` 的文档与错误信息都承诺「agent 作用域的贡献会遮蔽同名全局
 * 默认值」。所以在本该隐藏某 server 的 agent 作用域注册一个**同名空文本段**，
 * 就能让它的 instructions 不进入该 agent 的提示词，且不影响其它 agent。
 *
 * 边界：本模块只处理提示词段。**进程不会被停掉** —— MCP server 由 host 组合
 * 持有、与工作区无关；`tools.restrict` 与本节遮蔽省下的是 token，不是内存。
 *
 * @module dsh-workspace-scope/prompt
 */

/**
 * 与 `dsh-mcp-client` 保持一致的段名前缀。
 * @param serverName - MCP 服务器名（配置 `mcp` 段的键）。
 * @returns 系统提示段名。
 */
export const mcpSectionName = (serverName) => `mcp:${serverName}`;

/** 段在集中排序表里的位置名；与 mcp-client 注册时用的是同一个。 */
const MCP_SERVERS_ORDER = 'MCP_SERVERS';

/**
 * 创建按 agent 维护的遮蔽器。
 *
 * `apply` 是**幂等**的：只对比"应有的遮蔽集"与"当前的遮蔽集"做增删，
 * 所以可以挂在 `tools/change`、目录切换、配置变更上反复调用。
 *
 * @param options - 依赖。
 * @param options.logger - 可选日志器。
 * @returns `{ apply, forget, disposeAll }`。
 */
export function createPromptMasker({ logger } = {}) {
  /** agent.id → Map<serverName, disposer>。 */
  const masks = new Map();

  /**
   * 取（必要时创建）某 agent 的遮蔽登记表。
   * @param agentId - agent 标识。
   * @returns serverName → disposer 的映射。
   */
  function masksOf(agentId) {
    let map = masks.get(agentId);
    if (map === undefined) {
      map = new Map();
      masks.set(agentId, map);
    }
    return map;
  }

  /**
   * 按生效策略同步一个 agent 的提示词段遮蔽。
   *
   * @param agent - DSH agent（需要 `ctx.get('systemPrompt')`）。
   * @param effective - {@link ./config.js} 合并后的生效配置（只读 `effective.mcp`）。
   * @returns 无；失败只记日志，不抛出 —— 调用点多为事件回调。
   */
  function apply(agent, effective) {
    try {
      if (agent === undefined || agent === null || agent.id === undefined) return;
      const systemPrompt = agent.ctx?.get?.('systemPrompt');
      // 宿主没有 systemPrompt 服务（或该 scope 取不到）时静默跳过：这是可选增强。
      if (systemPrompt === undefined || systemPrompt === null) return;
      const order = systemPrompt.getSectionOrder(MCP_SERVERS_ORDER);
      if (!Number.isFinite(order)) return;

      // 应遮蔽 = 配置里**显式**为本工作区关闭的服务器；未出现的按默认可见处理。
      const wanted = new Set();
      for (const [server, enabled] of Object.entries(effective?.mcp ?? {})) {
        if (server !== '' && enabled === false) wanted.add(server);
      }

      const registered = masksOf(agent.id);

      // 先删多余，再补缺失：顺序无关，但"先删"让集合比较在一个回合内收敛。
      for (const [server, dispose] of registered) {
        if (wanted.has(server)) continue;
        try {
          dispose?.();
        } catch (error) {
          logger?.warn?.(`workspace-scope: 移除提示词遮蔽失败（agent ${String(agent.id)}，server ${server}）：${String(error?.message ?? error)}`);
        }
        registered.delete(server);
      }
      for (const server of wanted) {
        if (registered.has(server)) continue;
        const dispose = systemPrompt.section({
          name: mcpSectionName(server),
          order,
          // 空段会在 renderPrompt 阶段被丢弃（官方行为），等价于"这条段不存在"。
          text: '',
          interpolate: false,
        });
        registered.set(server, dispose);
      }
    } catch (error) {
      logger?.warn?.(`workspace-scope: 同步提示词遮蔽失败（agent ${String(agent?.id)}）：${String(error?.message ?? error)}`);
    }
  }

  /**
   * agent 销毁时清账（disposer 本身挂在 agent fiber 上随它消失，这里只清引用）。
   * @param agentId - agent 标识。
   */
  function forget(agentId) {
    masks.delete(agentId);
  }

  /**
   * 插件卸载 / HMR 时显式回收全部遮蔽，避免重载撞上同层同名段。
   */
  function disposeAll() {
    for (const registered of masks.values()) {
      for (const dispose of registered.values()) {
        try {
          dispose?.();
        } catch (error) {
          logger?.warn?.(`workspace-scope: 卸载提示词遮蔽失败：${String(error?.message ?? error)}`);
        }
      }
      registered.clear();
    }
    masks.clear();
  }

  return { apply, forget, disposeAll };
}
