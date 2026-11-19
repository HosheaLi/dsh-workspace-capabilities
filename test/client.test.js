/**
 * client 半边（手写 bundle）的契约测试。
 *
 * 浏览器里 `react` 是宿主种子、模块由 `window.__ModuleLoader__` 装载，所以这里用一个
 * 最小的 React 替身跑 factory，验证：bundle 形状正确、导出的 apply/inject 可用、
 * 两个 slot 都按官方写法（`slots.inject` + `slots.register`）注册、以及插入 `/名 ` 的
 * 纯逻辑。组件体不在 factory 期执行，替身只用来让模块求值通过；组件**真正渲染**时的
 * 契约（首帧不得抛错、数据到达后的面板内容）由 `test/render.test.js` 覆盖。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadBundleEntry, seedRequire } from './helpers/client-bundle.js';

/** 让模块在 node 里可加载：拿到共享的 bundle 入口，再 factory 出本用例专属的 exports。 */
async function loadBundle() {
  const entry = await loadBundleEntry();
  assert.equal(entry.id, 'dsh-workspace-capabilities');

  const React = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  };
  return entry.factory((name) => seedRequire(name, { react: React }));
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
  assert.equal(__logic.shortenPath('/home/me/code/x'), '~/code/x');
  assert.equal(__logic.shortenPath('/Users/someone'), '/Users/someone');
  assert.equal(__logic.shortenPath('/opt/other'), '/opt/other');
  // Windows：盘符 + Users + 用户名收敛成 ~，保留反斜杠；C:\Users 之外不动。
  assert.equal(__logic.shortenPath('C:\\Users\\someone\\code\\x'), '~\\code\\x');
  assert.equal(__logic.shortenPath('c:\\users\\someone\\code\\x'), '~\\code\\x', '大小写不敏感');
  assert.equal(__logic.shortenPath('C:\\Users\\someone'), 'C:\\Users\\someone');
  assert.equal(__logic.shortenPath('D:\\work\\x'), 'D:\\work\\x');
  // 用户根带尾分隔符：收敛成单个 `~`（不带尾分隔符的原样保留，与 POSIX 行为一致）。
  assert.equal(__logic.shortenPath('C:\\Users\\someone\\'), '~');
  assert.equal(__logic.shortenPath('/Users/someone/'), '~');
});

test('i18n：字典 zh/en 键集合一致，英文值里没有中文', async () => {
  const { __logic } = await loadBundle();
  const { zh, en } = __logic.MESSAGES;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), '两种语言的键必须一一对应');
  const leaked = Object.entries(en).filter(([, value]) => /[\u4e00-\u9fa5]/.test(value));
  assert.deepEqual(leaked, [], '英文文案不得残留中文（漏翻会在这里直接暴露）');
});

test('i18n：有 locale 服务时注册字典、插槽声明 locale 席位、标签按当前语言解析', async () => {
  const exports = await loadBundle();
  const registered = [];
  const registrations = [];
  const locale = {
    register: (ns, dicts) => {
      registered.push({ ns, dicts });
      return () => {};
    },
    resolveText: (text) => text.en,
  };
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    effect: (factory) => factory(),
    slots: {
      inject: (_key, callback) => callback(),
      register: (options) => {
        registrations.push(options);
        return () => {};
      },
    },
  };
  exports.apply(ctx);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].ns, 'workspace-scope');
  assert.ok(registered[0].dicts.zh !== undefined && registered[0].dicts.en !== undefined, '两种语言的字典都要注册');
  for (const options of registrations) assert.equal(options.locale, 'workspace-scope', '声明 locale 席位，宿主才会注入 t');
  const section = registrations.find((options) => options.name === 'settings.section');
  assert.equal(section.label, 'Workspace capabilities', '插槽显示名要按当前语言解析');
});
