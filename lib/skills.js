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
 * @module dsh-workspace-capabilities/skills
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
 * @param options.skills - 注册这份 provider 的 `ctx.skills`。
 * @param options.scope - 注册表视图的 scope：agent 层传 agent 本身，preset 层传该 preset
 *   的 scope key。内层 `list()` 要用它取"未降级的全量目录"。
 * @param options.agent - `scope` 的旧名字（agent 层调用方沿用），等价于传 `scope`。
 * @param options.providerName - 必须与注册时的 provider 名一致（注册表校验）。
 * @param options.resolvePolicy - `async (cwd) => ({ stateOf(name), })`，按 cwd 求生效策略。
 * @param options.logger - 可选日志器。
 * @returns 注册表要求的 provider 对象。
 */
export function createShadowProvider({ skills, scope, agent, providerName, resolvePolicy, logger }) {
  const viewScope = scope ?? agent;
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
        const catalog = await listWithoutCachingInnerResult(skills, {
          cwd: options.cwd,
          scope: viewScope,
          signal: options.signal,
        });
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

/**
 * 取"未降级的全量目录"，并丢弃这次内层读**新写进**注册表的缓存条目。
 *
 * 为什么要丢：注册表的 `collect()` 会把结果写进 `collectCache`，而这次内层读必然
 * 不含本 provider 的降级候选（重入哨兵让它返回空候选）。外层 collect 覆盖内层写入
 * 只发生在**同一个实例**上 —— 但 `layers` 是全局共享的、`collectCache` 却是**每实例
 * 一份**：agent 读会经注册表调用 preset 层 provider，那个 provider 的内层读落在
 * **preset 实例**上，于是 preset 实例的缓存里被塞进一份"未降级目录"；之后没有活动
 * agent 的冷读（输入框 `/` 菜单、面板目录）命中它，`manual`/`off` 的降级就丢了。
 *
 * 只删本次**新增**的键：删多了最坏是多扫一次目录（缓存 miss），不会给出错误结果；
 * 字段被并发调用换掉时（`skills.collectCache !== cache`）直接跳过，不去动别人的表。
 *
 * @param skills - 注册表实例。
 * @param options - `{ cwd, scope, signal }`，透传给 `list()`。
 * @returns 该 cwd 的未降级目录。
 */
async function listWithoutCachingInnerResult(skills, options) {
  const cache = skills?.collectCache;
  const known = cache instanceof Map ? new Set(cache.keys()) : undefined;
  const catalog = await skills.list(options);
  if (known !== undefined && skills.collectCache === cache) {
    for (const key of [...cache.keys()]) {
      if (!known.has(key)) cache.delete(key);
    }
  }
  return catalog;
}
