/**
 * 按 cwd 求生效策略（两级配置读取 + 短 TTL 缓存）。
 *
 * 枚举目录是**每个模型步**都会发生的事，而策略来自磁盘上的 JSON；这里做一个
 * 1 秒 TTL 的进程内缓存，写配置时由 {@link PolicyResolver#invalidate} 显式打掉，
 * 所以"改配置即时生效"不依赖 TTL。
 *
 * @module dsh-workspace-capabilities/policy
 */

import { mergeConfig, readConfigFile, resolveScope, skillStateOf } from './config.js';

/** 默认 TTL：1 秒。 */
const DEFAULT_TTL_MS = 1000;

/**
 * 创建一个策略解析器。
 * @param options - `{ env, ttlMs, now }`，测试可注入。
 * @returns 解析器：`read(cwd)` 拿生效策略，`invalidate(cwd)` 打缓存。
 */
export function createPolicyResolver(options = {}) {
  const env = options.env ?? process.env;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map();
  /**
   * 每个配置文件**上一次成功解析**的结果。
   *
   * 配置坏了就降级成空配置是危险的默认：用户手误写坏 JSON 时，原本 `off`/`manual` 的技能会
   * 静默回到目录，插件"省 token"的目的当场失效，而模型侧看不出任何异常。这里保留最后一份
   * 有效配置：解析失败时沿用它，同时把 `error` 照常带出去（面板会提示）。
   *
   * 边界：进程首次启动就读到坏文件时没有历史值，只能回落空配置 —— 那种情况仍然 fail-open，
   * 但面板会显示 `readError`，不再是完全静默。
   */
  const lastGood = new Map();
  /** 缓存代际：`invalidate()` 推进它，用来作废在途的 `compute`。 */
  let epoch = 0;

  /**
   * 读一层配置，坏文件时回落到上一次有效值。
   * @param path - 配置文件绝对路径。
   * @returns `readConfigFile` 的结果；回落时多带 `fallback: true`。
   */
  async function readLayer(path) {
    const read = await readConfigFile(path);
    if (read.error === undefined) {
      if (read.exists === true) lastGood.set(path, read.config);
      else lastGood.delete(path);
      return read;
    }
    const previous = lastGood.get(path);
    return previous === undefined ? read : { ...read, config: previous, fallback: true };
  }

  async function compute(cwd) {
    const scope = await resolveScope(typeof cwd === 'string' ? cwd : '', env);
    const globalRead = await readLayer(scope.globalPath);
    const projectRead = scope.projectLayer === true ? await readLayer(scope.projectPath) : { config: undefined, exists: false };
    return {
      scope,
      globalRead,
      projectRead,
      effective: mergeConfig(globalRead.config, projectRead.config),
      computedAt: now(),
    };
  }

  return {
    /**
     * 取某个 cwd 的生效策略（命中缓存则不读盘）。
     * @param cwd - 会话工作目录。
     * @param options - `{ fresh: true }` 强制重算。
     * @returns `{ scope, globalRead, projectRead, effective, computedAt, stateOf(name) }`。
     */
    async read(cwd, options = {}) {
      const key = typeof cwd === 'string' ? cwd : '';
      const cached = cache.get(key);
      if (options.fresh !== true && cached !== undefined && now() - cached.computedAt < ttlMs) return withAccessor(cached);
      const at = epoch;
      const entry = await compute(key);
      // 读盘期间发生过 invalidate：这次结果已经作废，**不能**写回缓存。否则写盘后的
      // "即时生效"会退化成"最多晚一个 TTL"，而这段时间内所有调用都会命中这份陈旧值。
      if (at === epoch) cache.set(key, entry);
      return withAccessor(entry);
    },

    /**
     * 打掉缓存并推进代际（同时作废在途的 `compute`）。
     *
     * 配置变更可能同时影响多个会话，所以一律清空；本插件只有这一种用法。
     */
    invalidate() {
      epoch += 1;
      cache.clear();
    },
  };
}

/** 给缓存条目挂上同步的 `stateOf`，避免调用方每次重算匹配。 */
function withAccessor(entry) {
  return {
    ...entry,
    /** @param name - 技能名 @returns 生效状态 */
    stateOf: (name) => skillStateOf(entry.effective, name),
  };
}
