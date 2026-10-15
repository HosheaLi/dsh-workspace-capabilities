/**
 * preset.js 的单元测试：preset standing scope 的探测、注册、幂等、回收与安静退化。
 *
 * 全部用 stub 驱动（`agentPresets.generations` 是宿主的运行时字段），不需要宿主运行时。
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPresetBinder } from '../lib/preset.js';

/**
 * 造一个带 `generations` 的 registry 替身。
 * @param entries - `[[key, generation], …]`。
 */
function registryOf(entries) {
  return { generations: new Map(entries) };
}

/**
 * 造一个 preset scope ctx 替身，记录注册与注销。
 * @param options - `{ register }` 可替换 `registerProvider` 行为。
 */
function scopeCtxOf({ register } = {}) {
  const calls = { registered: 0, disposed: 0 };
  const registerProvider = register ?? (() => {
    calls.registered += 1;
    return () => {
      calls.disposed += 1;
    };
  });
  return {
    calls,
    ctx: {
      get: (name) => (name === 'skills' ? { registerProvider } : undefined),
    },
  };
}

/** 只暴露 `agentPresets` 的插件 ctx 替身。 */
function pluginCtxOf(registry) {
  return { get: (name) => (name === 'agentPresets' ? registry : undefined) };
}

test('scan：为每个存活的 preset scope 注册一份 provider', () => {
  const a = scopeCtxOf();
  const b = scopeCtxOf();
  const keyA = { name: 'standard' };
  const keyB = { name: 'minimal' };
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([[keyA, { key: keyA, scope: { ctx: a.ctx } }], [keyB, { key: keyB, scope: { ctx: b.ctx } }]])),
    createProvider: ({ scope }) => ({ name: 'workspace-scope', scope }),
  });

  assert.equal(binder.scan(), 2);
  assert.equal(a.calls.registered, 1);
  assert.equal(b.calls.registered, 1);
});

test('scan：同一个 key 只注册一次（幂等）', () => {
  const scope = scopeCtxOf();
  const key = { name: 'standard' };
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([[key, { key, scope: { ctx: scope.ctx } }]])),
    createProvider: () => ({ name: 'workspace-scope' }),
  });

  binder.scan();
  binder.scan();
  assert.equal(scope.calls.registered, 1);
  assert.equal(binder.size(), 1);
});

test('scan：retired 或已消失的 preset 会被释放', () => {
  const scope = scopeCtxOf();
  const key = { name: 'standard' };
  const generations = new Map([[key, { key, scope: { ctx: scope.ctx } }]]);
  const binder = createPresetBinder({
    ctx: pluginCtxOf({ generations }),
    createProvider: () => ({ name: 'workspace-scope' }),
  });

  binder.scan();
  generations.set(key, { key, scope: { ctx: scope.ctx }, retired: true });
  assert.equal(binder.scan(), 0);
  assert.equal(scope.calls.disposed, 1);

  // 再扫一次不会再释放（账已清）。
  binder.scan();
  assert.equal(scope.calls.disposed, 1);
});

test('scan：preset 重建（新 key）会重新注册，旧 key 被释放', () => {
  const oldScope = scopeCtxOf();
  const newScope = scopeCtxOf();
  const oldKey = { name: 'standard-v1' };
  const newKey = { name: 'standard-v2' };
  const generations = new Map([[oldKey, { key: oldKey, scope: { ctx: oldScope.ctx } }]]);
  const binder = createPresetBinder({
    ctx: pluginCtxOf({ generations }),
    createProvider: () => ({ name: 'workspace-scope' }),
  });

  binder.scan();
  generations.clear();
  generations.set(newKey, { key: newKey, scope: { ctx: newScope.ctx } });
  assert.equal(binder.scan(), 1);
  assert.equal(oldScope.calls.disposed, 1);
  assert.equal(newScope.calls.registered, 1);
});

test('拿不到 registry / generations 结构：安静退化，不抛错', () => {
  for (const registry of [undefined, {}, { generations: [] }, { generations: null }]) {
    const binder = createPresetBinder({
      ctx: pluginCtxOf(registry),
      createProvider: () => ({ name: 'workspace-scope' }),
    });
    assert.equal(binder.scan(), 0);
    binder.invalidateAll();
    binder.disposeAll();
  }
});

test('get 抛错、generation 结构畸形、skills 缺失：都不抛出，只是跳过', () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const badGet = {
    get: () => {
      throw new Error('service store exploded');
    },
  };
  const malformed = { get: () => undefined };
  const keyA = { name: 'bad-get' };
  const keyB = { name: 'malformed' };
  const keyC = { name: 'no-skills' };
  const keyD = { name: 'null-generation' };
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([
      [keyA, { key: keyA, scope: { ctx: badGet } }],
      [keyB, { key: keyB, scope: { ctx: malformed } }],
      [keyC, { key: keyC, scope: { ctx: { get: () => undefined } } }],
      [keyD, null],
    ])),
    createProvider: () => ({ name: 'workspace-scope' }),
    logger,
  });

  assert.equal(binder.scan(), 0);
  assert.equal(warnings.length, 1, '只有取 skills 抛错的那条会告警');
  assert.match(warnings[0], /preset 层取 skills 失败/);
});

test('registerProvider 抛错（同层同名冲突）：告警但不影响其余 scope', () => {
  const warnings = [];
  const conflict = scopeCtxOf({
    register: () => {
      throw new Error('a skill provider named "workspace-scope" is already registered in this scope');
    },
  });
  const ok = scopeCtxOf();
  const keyA = { name: 'conflict' };
  const keyB = { name: 'ok' };
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([[keyA, { key: keyA, scope: { ctx: conflict.ctx } }], [keyB, { key: keyB, scope: { ctx: ok.ctx } }]])),
    createProvider: () => ({ name: 'workspace-scope' }),
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(binder.scan(), 1);
  assert.equal(ok.calls.registered, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /preset 层注册 shadow provider 失败/);
});

test('invalidateAll：逐条打掉目录缓存，单条抛错不连累其余', () => {
  const events = [];
  /** 造一个会在 invalidate 时记事件的 scope（`bad` 那条故意抛错）。 */
  const makeScope = (name) => scopeCtxOf({
    register: (create) => {
      create({
        invalidate: () => {
          events.push(`${name}:invalidate`);
          if (name === 'bad') throw new Error('invalidate exploded');
        },
      });
      return () => events.push(`${name}:dispose`);
    },
  });
  const bad = makeScope('bad');
  const good = makeScope('good');
  const keyA = { name: 'bad' };
  const keyB = { name: 'good' };
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([
      [keyA, { key: keyA, scope: { ctx: bad.ctx } }],
      [keyB, { key: keyB, scope: { ctx: good.ctx } }],
    ])),
    createProvider: () => ({ name: 'workspace-scope' }),
    logger: { warn: (message) => events.push(`warn:${message}`) },
  });

  binder.scan();
  events.length = 0;
  binder.invalidateAll();

  assert.deepEqual(
    events.filter((event) => event.endsWith(':invalidate')),
    ['bad:invalidate', 'good:invalidate'],
    '一条抛错不会中断其余条目',
  );
  assert.equal(events.filter((event) => event.startsWith('warn:')).length, 1);
});

test('scanWithRetries：首轮为空时按注入的调度重试，扫到即停', () => {
  const generations = new Map();
  const scheduled = [];
  const scope = scopeCtxOf();
  const key = { name: 'standard' };
  const binder = createPresetBinder({
    ctx: pluginCtxOf({ generations }),
    createProvider: () => ({ name: 'workspace-scope' }),
    retries: 3,
    intervalMs: 10,
    schedule: (fn) => {
      scheduled.push(fn);
      return () => {};
    },
  });

  binder.scanWithRetries();
  assert.equal(scheduled.length, 1, '首轮为空 → 排一次重试');

  generations.set(key, { key, scope: { ctx: scope.ctx } });
  scheduled[0]();
  assert.equal(binder.size(), 1);
  assert.equal(scheduled.length, 1, '扫到就不再排新的重试');
});

test('scanWithRetries：迟迟扫不到时重试次数有界', () => {
  const scheduled = [];
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([])),
    createProvider: () => ({ name: 'workspace-scope' }),
    retries: 2,
    intervalMs: 10,
    schedule: (fn) => {
      scheduled.push(fn);
      return () => {};
    },
  });

  binder.scanWithRetries();
  scheduled[0]();
  scheduled[1]();
  assert.equal(scheduled.length, 2, '最多 retries 次调度');
});

test('disposeAll：释放全部绑定', () => {
  const scope = scopeCtxOf();
  const key = { name: 'standard' };
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([[key, { key, scope: { ctx: scope.ctx } }]])),
    createProvider: () => ({ name: 'workspace-scope' }),
  });

  binder.scan();
  assert.equal(binder.size(), 1);
  binder.disposeAll();
  assert.equal(scope.calls.disposed, 1);
  assert.equal(binder.size(), 0);

  // 账已清：后续 scan 重新绑定算一次新注册，不会重复释放。
  binder.scan();
  assert.equal(scope.calls.registered, 2);
});

test('disposeAll：取消在途的启动期重试', () => {
  const cancelled = [];
  const scheduled = [];
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([])),
    createProvider: () => ({ name: 'workspace-scope' }),
    retries: 2,
    schedule: (fn) => {
      scheduled.push(fn);
      return () => cancelled.push(true);
    },
  });

  binder.scanWithRetries();
  assert.equal(scheduled.length, 1, '首轮扫不到 → 排了重试');
  binder.disposeAll();
  assert.equal(cancelled.length, 1, '在途重试被取消');

  // 定时器即使真的跑了也不再做事：账已清、binder 已释放。
  scheduled[0]();
  assert.equal(binder.size(), 0);
});

test('liveScopes：取 agentPresets 抛错时安静退化', () => {
  const binder = createPresetBinder({
    ctx: {
      get: () => {
        throw new Error('service store unavailable');
      },
    },
    createProvider: () => ({ name: 'workspace-scope' }),
  });

  assert.equal(binder.scan(), 0);
});

test('release：dispose 抛错只告警，账仍然清掉', () => {
  const warnings = [];
  const key = { name: 'standard' };
  const scope = scopeCtxOf({
    register: () => () => {
      throw new Error('dispose exploded');
    },
  });
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([[key, { key, scope: { ctx: scope.ctx } }]])),
    createProvider: () => ({ name: 'workspace-scope' }),
    logger: { warn: (message) => warnings.push(message) },
  });

  binder.scan();
  assert.equal(binder.size(), 1);
  binder.disposeAll();
  assert.equal(binder.size(), 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /卸载 preset 层 provider 失败/);
});

test('cancelRetries：取消函数抛错不影响清理', () => {
  const scheduled = [];
  const binder = createPresetBinder({
    ctx: pluginCtxOf(registryOf([])),
    createProvider: () => ({ name: 'workspace-scope' }),
    retries: 1,
    schedule: (fn) => {
      scheduled.push(fn);
      return () => {
        throw new Error('clearTimeout exploded');
      };
    },
  });

  binder.scanWithRetries();
  assert.equal(scheduled.length, 1);
  assert.doesNotThrow(() => binder.disposeAll());
});
