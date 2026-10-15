/**
 * preset 层 shadow provider 绑定 —— 让**没有活动 agent** 的读取也看到工作区策略。
 *
 * 为什么需要这一层：输入框的 `/` 技能菜单、以及面板的冷读，在没有活动 agent 的会话里
 * 走的是宿主 `SessionSkillCatalog.list` 的回落分支 —— `agents.get(sessionId)` 为空时
 * 它用 preset standing scope 读注册表（`skillRegistry.list({ cwd, scope: lease.key })`）。
 * agent 层的 shadow provider 在那条路径上不在层链里，于是 `off` 的技能照样被列出来，
 * 而用户选它插入后又会**静默**不注入正文 —— 这就是"关了还能用斜杠调用"的来源。
 *
 * 注册进 preset 层后：冷读的 `layers = [global, ...chainLayers(presetKey)]` 里就有我们的
 * 降级候选。同层内 rank 升序（`compareIndexedCandidates`），本插件的候选 rank 0 小于官方
 * `dsh-skill-filesystem` 的项目/用户根（100/200/300/400/500/600），所以赢家仍是本插件。
 *
 * 宿主没有公开"枚举 preset scope"的接口，`generations` 是 registry 的运行时字段
 * （`AgentPresetRegistry.activate` 在注册 preset 定义时创建，与有没有 agent 无关）。
 * 读不到就**安静退化**：保持 agent 层行为，不影响插件其余部分。
 *
 * @module dsh-workspace-scope/preset
 */

/** 找不到 preset registry 结构时的重试节奏：最多 8 次、间隔 250ms（共约 2 秒）。 */
const DEFAULT_SCAN_RETRIES = 8;
const DEFAULT_SCAN_INTERVAL_MS = 250;

/**
 * 创建一个 preset 层绑定器。
 *
 * @param options - `{ ctx, createProvider, logger, retries, intervalMs, schedule }`。
 * @param options.ctx - 插件上下文（用它取 `agentPresets` 服务）。
 * @param options.createProvider - `({ skills, scope }) => provider`，scope 是该 preset 的 key。
 * @param options.logger - 可选日志器。
 * @param options.retries - 启动期重试次数（默认 8）。
 * @param options.intervalMs - 重试间隔毫秒（默认 250）。
 * @param options.schedule - 定时器注入点（测试用），`(fn, ms) => cancel`。
 * @returns `{ scan, invalidateAll, disposeAll, size, cancelRetries }`。
 */
export function createPresetBinder({
  ctx,
  createProvider,
  logger,
  retries = DEFAULT_SCAN_RETRIES,
  intervalMs = DEFAULT_SCAN_INTERVAL_MS,
  schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer?.unref?.();
    return () => clearTimeout(timer);
  },
}) {
  /** preset scope key → `{ control, dispose }`。key 是对象，preset 重建必然换 key。 */
  const bindings = new Map();
  /** 启动期重试的取消函数（有界，见 schema 的 retries）。 */
  const cancels = new Set();

  /**
   * 当前存活的 preset scope。
   *
   * `generations` 是 registry 的运行时 Map（key → generation）；`generation.scope.ctx`
   * 就是那份 standing 组合的上下文，`scopeOf(它) === key`，也正是冷读用的 `lease.key`。
   * 结构对不上时返回空数组，交由调用方安静退化。
   *
   * @returns `[{ key, ctx }]`。
   */
  function liveScopes() {
    let registry;
    try {
      registry = ctx.get?.('agentPresets');
    } catch {
      return [];
    }
    const generations = registry?.generations;
    if (!(generations instanceof Map)) return [];
    const scopes = [];
    for (const [key, generation] of generations) {
      if (generation === null || typeof generation !== 'object') continue;
      if (generation.retired === true) continue;
      const scopeCtx = generation.scope?.ctx;
      if (scopeCtx === undefined || scopeCtx === null || typeof scopeCtx.get !== 'function') continue;
      scopes.push({ key, ctx: scopeCtx });
    }
    return scopes;
  }

  /**
   * 给一个 preset scope 注册 shadow provider（同 key 只注册一次）。
   * @param scope - `{ key, ctx }`，来自 {@link liveScopes}。
   */
  function bind(scope) {
    if (bindings.has(scope.key)) return;
    let skills;
    try {
      skills = scope.ctx.get('skills');
    } catch (error) {
      logger?.warn?.(`workspace-scope: preset 层取 skills 失败：${messageOf(error)}`);
      return;
    }
    if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') return;
    let control;
    try {
      const dispose = skills.registerProvider((registration) => {
        control = registration;
        return createProvider({ skills, scope: scope.key });
      });
      bindings.set(scope.key, { control, dispose });
    } catch (error) {
      // 同一层同名 provider 冲突、或注册表拒绝：都不该让插件其余功能受影响。
      logger?.warn?.(`workspace-scope: preset 层注册 shadow provider 失败：${messageOf(error)}`);
    }
  }

  /**
   * 释放一条绑定。
   * @param key - preset scope key。
   * @param entry - `{ dispose }`。
   */
  function release(key, entry) {
    bindings.delete(key);
    try {
      entry.dispose?.();
    } catch (error) {
      logger?.warn?.(`workspace-scope: 卸载 preset 层 provider 失败：${messageOf(error)}`);
    }
  }

  /** 取消所有在途的启动期重试。 */
  function cancelRetries() {
    for (const cancel of cancels) {
      try {
        cancel();
      } catch {
        /* 取消本身失败无所谓，定时器已 unref */
      }
    }
    cancels.clear();
  }

  /**
   * 重新对齐 preset 层绑定：新出现的 scope 注册，已消失的释放。
   * @returns 当前绑定的 preset 数。
   */
  function scan() {
    const live = liveScopes();
    const seen = new Set();
    for (const scope of live) {
      seen.add(scope.key);
      bind(scope);
    }
    for (const [key, entry] of [...bindings]) {
      if (!seen.has(key)) release(key, entry);
    }
    return bindings.size;
  }

  /**
   * 启动期有界重试：preset 定义的注册时机可能晚于插件 apply（两者都是 loader 装配行，
   * 顺序由 profile patch 决定）。扫到至少一个 scope 就停，避免常驻轮询。
   */
  function scanWithRetries() {
    if (scan() > 0 || retries <= 0) return;
    let left = retries;
    const tick = () => {
      if (scan() > 0 || left <= 0) return;
      left -= 1;
      cancels.add(schedule(tick, intervalMs));
    };
    left -= 1;
    cancels.add(schedule(tick, intervalMs));
  }

  /** 让所有 preset 层 provider 的目录缓存失效（配置写盘后调用）。 */
  function invalidateAll() {
    for (const { control } of bindings.values()) {
      try {
        control?.invalidate?.();
      } catch (error) {
        logger?.warn?.(`workspace-scope: preset 层目录缓存失效失败：${messageOf(error)}`);
      }
    }
  }

  /** 释放全部绑定并停止重试（插件卸载 / HMR）。 */
  function disposeAll() {
    cancelRetries();
    for (const [key, entry] of [...bindings]) release(key, entry);
  }

  return {
    scan,
    scanWithRetries,
    invalidateAll,
    disposeAll,
    cancelRetries,
    size: () => bindings.size,
  };
}

/**
 * 取错误的可读文本。
 * @param error - 任意抛错值。
 * @returns 消息字符串。
 */
function messageOf(error) {
  return String(error?.message ?? error);
}
