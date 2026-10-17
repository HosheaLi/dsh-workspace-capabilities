/**
 * dsh-workspace-scope —— host 半边。
 *
 * 按工作区（项目目录）决定技能是否进入模型目录，并屏蔽无关 MCP 服务器的工具。
 *
 * 三件事，逐一对应设计文档里的机制落点：
 *  1. **两层 shadow provider**：把该工作区判定为 `manual`/`off` 的技能降级为
 *     `{ modelInvocable:false, userInvocable: ? }`。官方三条路径的判定是分开的，
 *     所以这一档精确得到"模型看不见、但 `/名` 仍能注入全文"的语义，不改任何官方
 *     文件、也不拦截工具调用。注册分两层，缺一不可：
 *     - **agent 层**（`agent.ctx.get('skills')`）：模型目录与 `/名` 手势走这条链。
 *       注册在 host 全局层会被 preset 层静默盖掉，所以必须落在 agent 层。
 *     - **preset 层**（`preset.js`）：**没有活动 agent** 的会话里，输入框 `/` 菜单与
 *       面板目录走宿主的冷读回落（preset standing scope），只有 preset 层注册才看得见。
 *  2. **MCP 工具可见性**：按会话**当前**工作目录求 `tools.restrict({ deny })`（0.2.1 起
 *     `workingDirectory` 服务支持会话内 `cd`，取不到时回落 `session.header.cwd`），并在
 *     `tools/change` 上持续补偿（MCP 工具是异步注册的），目录切换时重算。
 *  3. **面板 RPC**：注册在 `webServer` 的 exact 路由 `POST /api/workspace-scope/rpc` 上，
 *     但**逐请求**过官方 `connection.requestRejection` 栅栏 —— 见 `rpc.js` 里
 *     "为什么不用 `connection.fetch.register`" 的说明。
 *
 * `apply` **必须同步**：Cordis 不把 `async apply` 返回的 Promise 当启动工作，其中
 * 抛错不会让插件激活失败，而会成为 unhandled rejection（可能终止进程）。所以这里
 * 用同步 `apply`，并把所有异步收尾都 `.catch()` 掉。
 *
 * @module dsh-workspace-scope
 */

import { effectiveCwdOf } from './cwd.js';
import { denyNamesFor, createMcpRestrictor } from './mcp.js';
import { createPolicyResolver } from './policy.js';
import { createPresetBinder } from './preset.js';
import { createRpcMethods, registerRpcSurface } from './rpc.js';
import { createShadowProvider } from './skills.js';

export const name = 'workspace-scope';

/** 需要的服务：技能注册表、工具注册表、agent 花名册。`agentPresets` 走可选注入。 */
export const inject = ['skills', 'tools', 'agents'];

/** 本插件注册的 shadow provider 名（每层内唯一；agent 层与 preset 层各注册一份）。 */
const PROVIDER_NAME = 'workspace-scope';

/**
 * 插件入口（同步，见模块头注释）。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const logger = ctx.logger;

  /** 两级配置读取 + 1 秒 TTL 缓存；写盘时显式 invalidate。 */
  const policy = createPolicyResolver({ env: process.env });

  /** agent.id → { control, dispose }：该 agent 的 shadow provider 注册。 */
  const registrations = new Map();

  /**
   * 按 agent **当前**工作目录求 deny 名单。
   *
   * 0.2.1 起会话可以 `cd`（`working_directory` 工具），当前目录不等于
   * `session.header.cwd`；这里统一走 {@link effectiveCwdOf}，旧宿主自动回落。
   *
   * `pinned`/`manual` 与 MCP 无关；这里只关心 `mcp` 段。`ctx.tools.schemas()` 给的是
   * host 全局的工具表，MCP 服务器由 `$DSH_HOME/cordis.patch.yml` 挂在 host 组合里，
   * 所以全局表就是完整的 MCP 工具来源。
   */
  async function denyForAgent(agent) {
    const cwd = effectiveCwdOf(ctx, agent);
    const entry = await policy.read(cwd);
    // 已知服务器名来自配置文件的 mcp 段：名字本身可能含 `__`，反解不可靠（见 mcp.js）。
    return denyNamesFor(ctx.tools.schemas(), (server) => {
      const explicit = entry.effective.mcp[server];
      return explicit === undefined ? true : explicit;
    }, Object.keys(entry.effective.mcp));
  }

  const restrictor = createMcpRestrictor({ denyNamesFor: denyForAgent, logger });

  /**
   * preset 层绑定：没有活动 agent 的冷读（输入框 `/` 菜单、面板目录）走的是
   * preset standing scope，agent 层的注册在那条路径上不可见 —— 见 `preset.js`。
   */
  const presetBinder = createPresetBinder({
    ctx,
    logger,
    createProvider: ({ skills, scope }) => createShadowProvider({
      skills,
      scope,
      providerName: PROVIDER_NAME,
      resolvePolicy: (cwd) => policy.read(cwd),
      logger,
    }),
  });

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
          scope: agent,
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

  /** 配置变更后让所有 agent 与 preset 的目录缓存失效，并重算 MCP 屏蔽。 */
  function invalidateAll() {
    for (const { control } of registrations.values()) {
      try {
        control?.invalidate();
      } catch (error) {
        logger?.warn?.(`workspace-scope: 目录缓存失效失败：${String(error?.message ?? error)}`);
      }
    }
    presetBinder.invalidateAll();
    // preset 定义可能在插件 apply 之后才注册（两者都是 loader 装配行）。
    presetBinder.scan();
    // 配置变更不会发 tools/change，所以在途的 apply 只能靠代际推进来重算：否则它在
    // 写盘前读到的旧策略会盖住这次改动（哨兵会挡掉紧随其后的重算调用）。
    restrictor.noteChange();
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

  // preset 层：`agentPresets` 就绪时对齐一次，启动期再用有界重试兜住"preset 定义注册
  // 晚于本插件 apply"的装配顺序（见 preset.js）。两条路径都不依赖有没有活动 agent。
  presetBinder.scanWithRetries();
  ctx.inject?.(['agentPresets'], () => {
    presetBinder.scan();
  });

  ctx.on('agent/created', ({ agent }) => {
    bindAgent(agent);
    presetBinder.scan();
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
    presetBinder.scan();
    applyRestrictionsToAll();
  });

  // 会话内 `cd`（0.2.1 的 `working_directory`）：当前目录变了，MCP deny 必须按新目录重算。
  // 目录切换记在会话事件里（不是 ctx 服务事件），事件签名是 `(session, event)`；agent 与
  // session 用对象身份对应。`workingDirectory.get()` 只读投影，重算本身不读盘（policy 有缓存）。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'working-directory/change') return;
    const agent = ctx.agents.list().find((candidate) => candidate?.session === session);
    if (agent === undefined) return;
    void restrictor.apply(agent);
  });

  // 插件卸载 / HMR：agent 层与 preset 层的注册都不随插件 fiber 自动销毁，必须显式收尾，
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
    presetBinder.disposeAll();
    restrictor.disposeAll();
  }, 'workspace-scope: agent-layer cleanup');
}
