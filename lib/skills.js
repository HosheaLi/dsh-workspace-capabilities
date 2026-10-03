/**
 * agent 层的 shadow provider —— 本插件的核心机制落点。
 *
 * 为什么必须注册在 **agent 层**（`agent.ctx.get('skills')`）而不是 host 全局层：
 * 技能注册表按层合并，`layers = [global, ...chainLayers(scope)]` 逐层 `set(name, entry)`，
 * 后写覆盖先写 —— **越近的层直接赢，与 rank 无关**。本地技能 provider 挂在 agent
 * preset 层（`presets/standard.patch.yml` 的 `skill-filesystem` 行），而
 * `chainLayers(agent) = [presetLayer, agentLayer]`，所以在 host 全局层注册会被
 * preset 层静默盖掉，过滤完全不生效。
 *
 * 三态如何落到官方三条判定路径（`dsh-tool-skill` 的 `isModelInvocable` /
 * `isUserInvocable` 是**分开**判的）：
 *  - `pinned`：不返回候选，官方 provider 继续供数 —— 行为与现状完全一致；
 *  - `manual`：返回 `{ modelInvocable:false, userInvocable:true }` —— 不进
 *    `<available_skills>`、`skill` 工具报 not available，但 `/名` 手势仍注入全文；
 *  - `off`：返回 `{ modelInvocable:false, userInvocable:false }` —— 连 `/名` 也不注入。
 *
 * @module dsh-workspace-scope/skills
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';

import { manageabilityOf, readSkillBody } from './catalog.js';

/**
 * 创建一个绑定到某个 agent 作用域的 shadow provider。
 *
 * **重入哨兵**：`list()` 内部读注册表会重新进入自己。内层调用必须返回空候选，
 * 让外层拿到"未降级的全量目录"；注册表在外层 collect 结束时用它覆盖内层写入的
 * 缓存，所以最终缓存里是对的那一份。判据是**同一条 async 调用链**
 * （{@link AsyncLocalStorage}），不是"同一个 cwd"。
 *
 * @param options - provider 依赖与策略。
 * @param options.skills - 该 agent 的 `ctx.skills`（`agent.ctx.get('skills')`）。
 * @param options.agent - 该 agent 本身，作为注册表视图的 scope。
 * @param options.providerName - 必须与注册时的 provider 名一致（注册表校验）。
 * @param options.resolvePolicy - `async (cwd) => ({ stateOf(name), })`，按 cwd 求生效策略。
 * @param options.logger - 可选日志器。
 * @returns 注册表要求的 provider 对象。
 */
export function createShadowProvider({ skills, agent, providerName, resolvePolicy, logger }) {
  /**
   * 真重入哨兵：只短路**同一条 async 调用链**内重新进入自己的那次调用。
   *
   * 按 cwd 记名的集合做不到这件事 —— 它会把两个独立调用者的同 cwd 并发枚举也当成
   * 重入，后来者拿到空候选、返回未降级目录，`manual`/`off` 技能于是被重新广告给模型。
   */
  const reentrant = new AsyncLocalStorage();

  return {
    name: providerName,

    /**
     * 返回本工作区被降级的技能候选；`pinned` 的一律不返回。
     * @param options - 注册表传入的视图选项（含 `cwd` / `signal`）。
     */
    async list(options = {}) {
      if (reentrant.getStore() === true) return [];
      return reentrant.run(true, async () => {
        const catalog = await skills.list({ cwd: options.cwd, scope: agent, signal: options.signal });
        const policy = await resolvePolicy(options.cwd);
        const candidates = [];
        for (const skill of catalog) {
          if (skill === null || typeof skill !== 'object') continue;
          if (typeof skill.name !== 'string' || typeof skill.description !== 'string' || skill.description === '') continue;
          if (!manageabilityOf(skill).manageable) continue;
          const state = policy.stateOf(skill.name);
          if (state === 'pinned') continue;
          candidates.push({
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
            invocation: state === 'off'
              ? { modelInvocable: false, userInvocable: false }
              : { modelInvocable: false, userInvocable: true },
            source: typeof skill.source === 'string' ? skill.source : 'custom',
            provider: providerName,
            rank: 0,
            path: skill.path,
            locator: { path: skill.path, directory: dirname(skill.path) },
            ...(skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase }),
          });
        }
        return candidates;
      });
    },

    /**
     * 按候选自己的 `path` 读回正文，复刻官方的 `content = body.trim()` 规则。
     *
     * **不得委托 `ctx.skills.get()`**：赢家仍是自己，会无限递归。
     * @param candidate - `list()` 刚返回的候选（`locator` 携带路径）。
     * @param options - `{ signal }`。
     * @returns 完整 definition，或 `undefined`（拒绝加载正文）。
     */
    async get(candidate, options = {}) {
      const locator = candidate?.locator;
      const path = typeof locator?.path === 'string' ? locator.path : candidate?.path;
      if (typeof path !== 'string' || path === '') return undefined;
      const content = await readSkillBody(path, options?.signal);
      if (content === undefined) {
        logger?.warn?.(`workspace-scope: 技能 "${candidate?.name}" 的正文读取失败或缺少合法 frontmatter：${path}`);
        return undefined;
      }
      return {
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: providerName,
        ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
        path,
        content,
      };
    },
  };
}
