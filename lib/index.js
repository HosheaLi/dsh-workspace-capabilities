/**
 * dsh-workspace-scope —— host 半边。
 *
 * 按工作区（项目目录）决定技能是否进入模型目录，并屏蔽无关 MCP 服务器的工具。
 *
 * 三件事，逐一对应设计文档里的机制落点：
 *  1. **agent 层 shadow provider**：把该工作区判定为 `manual`/`off` 的技能降级为
 *     `{ modelInvocable:false, userInvocable: ? }`。官方三条路径的判定是分开的，
 *     所以这一档精确得到"模型看不见、但 `/名` 仍能注入全文"的语义，不改任何官方
 *     文件、也不拦截工具调用。注册必须落在 **agent 层**：注册表按层合并，近层直接
 *     赢，注册在 host 全局层会被 preset 层静默盖掉。
 *  2. **MCP 工具可见性**：按 `agent.session.header.cwd` 求 `tools.restrict({ deny })`，
 *     并在 `tools/change` 上持续补偿（MCP 工具是异步注册的）。
 *  3. **面板 RPC**：经 `connection.fetch.register` 挂在官方守好的 `/api` 下，
 *     供浏览器面板读写配置。
 *
 * `apply` **必须同步**：Cordis 不把 `async apply` 返回的 Promise 当启动工作，其中
 * 抛错不会让插件激活失败，而会成为 unhandled rejection（可能终止进程）。所以这里
 * 用同步 `apply`，并把所有异步收尾都 `.catch()` 掉。
 *
 * @module dsh-workspace-scope
 */

import { denyNamesFor, createMcpRestrictor } from './mcp.js';
import { createPolicyResolver } from './policy.js';
import { createRpcMethods, registerRpcSurface } from './rpc.js';
import { createShadowProvider } from './skills.js';

export const name = 'workspace-scope';

/** 需要的服务：技能注册表、工具注册表、agent 花名册。 */
export const inject = ['skills', 'tools', 'agents'];

/** 本插件在 agent 层注册的 shadow provider 名（层内唯一）。 */
const PROVIDER_NAME = 'workspace-scope';

/**
 * 插件入口（同步，见模块头注释）。
 * @param ctx - 插件上下文。
 * @param config - 预留的组合配置（当前无字段）。
 */
export function apply(ctx, config = {}) {
  void config;
  const logger = ctx.logger;

  /** 两级配置读取 + 1 秒 TTL 缓存；写盘时显式 invalidate。 */
  const policy = createPolicyResolver({ env: process.env });

  /** agent.id → { control, dispose }：该 agent 的 shadow provider 注册。 */
  const registrations = new Map();

  /**
   * 按 agent 的 cwd 求 deny 名单。
   *
   * `pinned`/`manual` 与 MCP 无关；这里只关心 `mcp` 段。`ctx.tools.schemas()` 给的是
   * host 全局的工具表，MCP 服务器由 `$DSH_HOME/cordis.patch.yml` 挂在 host 组合里，
   * 所以全局表就是完整的 MCP 工具来源。
   */
  async function denyForAgent(agent) {
    const cwd = agent?.session?.header?.cwd;
    const entry = await policy.read(cwd);
    return denyNamesFor(ctx.tools.schemas(), (server) => {
      const explicit = entry.effective.mcp[server];
      return explicit === undefined ? true : explicit;
    });
  }

  const restrictor = createMcpRestrictor({ denyNamesFor: denyForAgent, logger });

  /** 给一个 agent 注册 shadow provider（幂等）。 */
  function bindAgent(agent) {
    try {
      if (agent === undefined || agent === null || registrations.has(agent.id)) return;
      const skills = agent.ctx?.get?.('skills');
      if (skills === undefined) return;
      let control;
      const dispose = skills.registerProvider((registration) => {
        control = registration;
        return createShadowProvider({
          skills,
          agent,
          providerName: PROVIDER_NAME,
          resolvePolicy: (cwd) => policy.read(cwd),
          logger,
        });
      });
      registrations.set(agent.id, { control, dispose });
    } catch (error) {
      logger?.warn?.(`workspace-scope: 注册 shadow provider 失败（agent ${String(agent?.id)}）：${String(error?.message ?? error)}`);
    }
  }

  /** 配置变更后让所有 agent 的目录缓存失效，并重算 MCP 屏蔽。 */
  function invalidateAll() {
    for (const { control } of registrations.values()) {
      try {
        control?.invalidate();
      } catch (error) {
        logger?.warn?.(`workspace-scope: 目录缓存失效失败：${String(error?.message ?? error)}`);
      }
    }
    applyRestrictionsToAll();
  }

  /** 对所有已知 agent 重算 MCP 屏蔽（同步触发，逐个 await 由各自的 apply 负责）。 */
  function applyRestrictionsToAll() {
    for (const agent of ctx.agents.list()) void restrictor.apply(agent);
  }

  // ── 面板 RPC ───────────────────────────────────────────────────────────────
  const methods = createRpcMethods({ ctx, policy, notifyChanged: () => invalidateAll() });
  const disposeRoute = registerRpcSurface({ ctx, methods, logger });
  ctx.effect(() => disposeRoute, 'workspace-scope: panel route');

  // ── 生命周期 ───────────────────────────────────────────────────────────────
  // 覆盖两条路径：插件热加载时已存在的 agent，以及此后才创建的 agent（create 与
  // resume 都会走到 agent/created）。
  for (const agent of ctx.agents.list()) {
    bindAgent(agent);
    void restrictor.apply(agent);
  }

  ctx.on('agent/created', ({ agent }) => {
    bindAgent(agent);
    void restrictor.apply(agent);
  });

  // agent 销毁：provider 与限制层都挂在 agent fiber 上、随它一起消失，这里只清账。
  ctx.on('agent/disposed', ({ agent }) => {
    registrations.delete(agent.id);
    restrictor.forget(agent.id);
  });

  // MCP 工具是异步注册的（listTools 有网络往返）：这里做第 2 步补偿，补齐重连、
  // 迟到注册、挂载 settle 之后出现的工具。restrict 自身会同步 emit tools/change，
  // 施加器内部的哨兵 + 代际补偿保证不会递归。
  ctx.on('tools/change', () => {
    restrictor.noteChange();
    applyRestrictionsToAll();
  });

  // 插件卸载 / HMR：agent 层注册与限制层都不随插件 fiber 自动销毁，必须显式收尾，
  // 否则重载会撞上"同层同名 provider 已注册"。
  ctx.effect(() => () => {
    for (const { dispose } of registrations.values()) {
      try {
        dispose();
      } catch (error) {
        logger?.warn?.(`workspace-scope: 卸载 shadow provider 失败：${String(error?.message ?? error)}`);
      }
    }
    registrations.clear();
    restrictor.disposeAll();
  }, 'workspace-scope: agent-layer cleanup');

  // 启动时若已有配置，先把策略读热，避免首个 tools/change 拿不到 deny 名单。
  for (const agent of ctx.agents.list()) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd !== '') void policy.read(cwd).then(() => restrictor.apply(agent)).catch(() => {});
  }
}
