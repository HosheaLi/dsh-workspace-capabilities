/**
 * client 半边（手写 bundle）的契约测试。
 *
 * 浏览器里 `react` 是宿主种子、模块由 `window.__ModuleLoader__` 装载，所以这里用一个
 * 最小的 React 替身跑 factory，验证：bundle 形状正确、导出的 apply/inject 可用、
 * 两个 slot 都按官方写法（`slots.inject` + `slots.register`）注册、以及插入 `/名 ` 的
 * 纯逻辑。组件体不在 factory 期执行，替身只用来让模块求值通过。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

/** 让模块在 node 里可加载：捕获 `window.__ModuleLoader__.load` 的入参。 */
async function loadBundle() {
  let captured;
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        captured = entry;
      },
    },
  };
  await import(`${pathToFileURL(new URL('../lib/client.js', import.meta.url).pathname).href}?t=${Date.now()}`);
  assert.ok(captured !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-workspace-scope');

  const React = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  };
  const exports = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`bundle 不允许 require 平台种子之外的模块：${name}`);
  });
  return exports;
}

test('bundle 形状：导出 apply / inject，只 require react', async () => {
  const exports = await loadBundle();
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots']);
});

test('apply 用官方写法注册两个 slot（conversation.input.right / settings.section）', async () => {
  const exports = await loadBundle();
  const registrations = [];
  const injections = [];
  const ctx = {
    effect: (factory) => {
      factory();
    },
    slots: {
      inject: (key, callback) => {
        injections.push(key);
        return callback();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  exports.apply(ctx);

  assert.deepEqual(injections.sort(), ['conversation.input.right', 'settings.section']);
  assert.equal(registrations.length, 2);
  const byName = new Map(registrations.map((entry) => [entry.options.name, entry.options]));
  assert.equal(byName.get('conversation.input.right').id, 'workspace-scope');
  assert.equal(typeof byName.get('conversation.input.right').order, 'number');
  assert.equal(byName.get('settings.section').id, 'workspace-scope');
  assert.equal(byName.get('settings.section').label, '工作区能力');
  for (const entry of registrations) assert.equal(typeof entry.component, 'function');
});

test('插入逻辑：拼成 `/名 `，按当前 draft 决定分隔符，且不吞掉用户已输入内容', async () => {
  const { __logic } = await loadBundle();
  const calls = [];
  const inputActions = { setDraft: (text) => calls.push(text) };

  __logic.insertSkill(inputActions, '', 'alpha');
  __logic.insertSkill(inputActions, '已有内容', 'beta');
  __logic.insertSkill(inputActions, '结尾有空格 ', 'gamma');
  __logic.insertSkill(inputActions, '换行\n', 'delta');

  assert.deepEqual(calls, ['/alpha ', '已有内容 /beta ', '结尾有空格 /gamma ', '换行\n/delta ']);

  assert.throws(() => __logic.insertSkill(undefined, '', 'x'), /setDraft/);
});

test('展示辅助：字节数与路径收敛', async () => {
  const { __logic } = await loadBundle();
  assert.equal(__logic.readableSize(512), '512 B');
  assert.equal(__logic.readableSize(2048), '2.0 KB');
  assert.equal(__logic.readableSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(__logic.readableSize(undefined), '');
  assert.equal(__logic.shortenPath('/Users/someone/code/x'), '~/code/x');
  assert.equal(__logic.shortenPath('/opt/other'), '/opt/other');
});
