/**
 * skills.js 的单元测试：shadow provider 的候选构造、三态语义、真重入哨兵与正文读回。
 *
 * 用 stub 注册表驱动，不需要宿主运行时。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createShadowProvider } from '../lib/skills.js';

/** 造一个可管理的 registry summary。 */
const skill = (name, extra = {}) => ({
  name,
  description: `${name} 的描述`,
  source: 'custom',
  path: `/x/${name}/SKILL.md`,
  invocation: { modelInvocable: true, userInvocable: true },
  ...extra,
});

/**
 * 造一个 shadow provider。
 * @param options - `{ catalog, states, list, logger }`；`list` 可替换注册表实现。
 */
function makeProvider({ catalog = [], states = {}, list, logger } = {}) {
  const calls = { list: [], warn: [] };
  const provider = createShadowProvider({
    skills: {
      list: async (options) => {
        calls.list.push(options);
        if (list !== undefined) return list(options, provider);
        return catalog;
      },
    },
    agent: { id: 'agent-1' },
    providerName: 'workspace-scope',
    resolvePolicy: async () => ({ stateOf: (name) => states[name] ?? 'pinned' }),
    logger: logger ?? { warn: (...args) => calls.warn.push(args.join(' ')) },
  });
  return { provider, calls };
}

test('list：只返回被降级的可管理技能，pinned 与不可接管的来源都不返回', async () => {
  const { provider } = makeProvider({
    catalog: [
      skill('keep'),
      skill('manual-one'),
      skill('off-one'),
      skill('bundled', { source: 'bundled' }),
      skill('no-path', { path: undefined }),
      null,
      { name: 42, description: '类型不对', source: 'custom', path: '/x' },
      { name: 'no-desc', description: '', source: 'custom', path: '/x' },
    ],
    states: { 'manual-one': 'manual', 'off-one': 'off', bundled: 'off', 'no-path': 'off' },
  });

  const rows = await provider.list({ cwd: '/p' });
  assert.deepEqual(rows.map((row) => row.name), ['manual-one', 'off-one']);

  const manual = rows.find((row) => row.name === 'manual-one');
  assert.deepEqual(manual.invocation, { modelInvocable: false, userInvocable: true }, 'manual 保留 /名 手势');
  assert.equal(manual.provider, 'workspace-scope');
  assert.equal(manual.rank, 0);
  assert.deepEqual(manual.locator, { path: '/x/manual-one/SKILL.md', directory: '/x/manual-one' });

  const off = rows.find((row) => row.name === 'off-one');
  assert.deepEqual(off.invocation, { modelInvocable: false, userInvocable: false }, 'off 两条路径都关');
});

test('list：把 whenToUse / resourceBase 原样带过去', async () => {
  const { provider } = makeProvider({
    catalog: [skill('a', { whenToUse: '当需要 a 时', resourceBase: { kind: 'directory', path: '/x/a' } })],
    states: { a: 'manual' },
  });
  const [row] = await provider.list({ cwd: '/p' });
  assert.equal(row.whenToUse, '当需要 a 时');
  assert.deepEqual(row.resourceBase, { kind: 'directory', path: '/x/a' });
});

test('list：真重入（同一调用链回环）返回空候选，并发调用各自正常降级', async () => {
  // 注册表在一次 collect 里会回调 provider.list 自己：内层必须返回 []，否则外层拿不到
  // "未降级的全量目录"。用 stub 模拟这条回环。
  const { provider } = makeProvider({
    states: { secret: 'manual' },
    list: async (_options, self) => {
      const inner = await self.list({ cwd: '/p' });
      assert.deepEqual(inner, [], '同一 async 调用链内的重入必须返回空候选');
      return [skill('secret')];
    },
  });
  const rows = await provider.list({ cwd: '/p' });
  assert.deepEqual(rows.map((row) => row.name), ['secret'], '外层照常构造降级候选');

  // 并发（不同调用链）不应被误判为重入：两路都要拿到降级结果。
  const { provider: plain } = makeProvider({ catalog: [skill('secret')], states: { secret: 'manual' } });
  const [first, second] = await Promise.all([plain.list({ cwd: '/p' }), plain.list({ cwd: '/p' })]);
  assert.deepEqual(first.map((row) => row.name), ['secret']);
  assert.deepEqual(second.map((row) => row.name), ['secret']);
});

test('get：按 path 读回正文；路径缺失或读取失败时返回 undefined 并告警', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wscope-skills-'));
  try {
    const dir = join(base, 'demo');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    await writeFile(path, '---\nname: demo\ndescription: 描述\n---\n\n正文\n', 'utf8');

    const { provider, calls } = makeProvider({});
    const candidate = {
      name: 'demo',
      description: '描述',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'custom',
      locator: { path, directory: dir },
    };
    const loaded = await provider.get(candidate);
    assert.equal(loaded.content, '正文', '正文是去 frontmatter 后 trim 的结果');
    assert.equal(loaded.provider, 'workspace-scope');
    assert.equal(loaded.path, path);

    // 缺 path / path 为空：拒绝加载，不告警（不是文件问题）
    assert.equal(await provider.get({ name: 'no-path' }), undefined);
    assert.equal(await provider.get({ name: 'empty', path: '' }), undefined);

    // 文件不存在：读回失败 → 告警并返回 undefined
    const missing = { name: 'gone', locator: { path: join(base, 'nope', 'SKILL.md') } };
    assert.equal(await provider.get(missing), undefined);
    assert.match(calls.warn.join('\n'), /正文读取失败或缺少合法 frontmatter/);

    // 文件存在但没有合法 frontmatter：同样拒绝
    const bad = join(base, 'bad.md');
    await writeFile(bad, '没有 frontmatter 的正文', 'utf8');
    assert.equal(await provider.get({ name: 'bad', path: bad }), undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('list：scope 参数优先于 agent（preset 层注册用 preset scope key）', async () => {
  const presetKey = { name: 'preset-1' };
  const calls = [];
  const provider = createShadowProvider({
    skills: {
      list: async (options) => {
        calls.push(options);
        return [];
      },
    },
    scope: presetKey,
    agent: { id: '不该被用到' },
    providerName: 'workspace-scope',
    resolvePolicy: async () => ({ stateOf: () => 'pinned' }),
  });

  assert.deepEqual(await provider.list({ cwd: '/x' }), []);
  assert.equal(calls[0].scope, presetKey, '内层读必须用 preset scope，不是 agent');
});

test('list：内层读新写入的目录缓存被丢弃，原有条目保留', async () => {
  const cache = new Map([['existing', { entries: 'keep-me' }]]);
  const provider = createShadowProvider({
    skills: {
      collectCache: cache,
      async list() {
        // 注册表在内层 collect 结束时写入的"未降级目录"（跨实例时没人覆盖它）。
        cache.set('inner', { entries: '未降级目录' });
        return [];
      },
    },
    scope: { name: 'preset-1' },
    providerName: 'workspace-scope',
    resolvePolicy: async () => ({ stateOf: () => 'pinned' }),
  });

  assert.deepEqual(await provider.list({ cwd: '/x' }), []);
  assert.equal(cache.has('inner'), false, '未降级目录不得留在缓存里被冷读命中');
  assert.deepEqual(cache.get('existing'), { entries: 'keep-me' }, '别人的缓存条目不动');
});

test('list：注册表没有 collectCache（宿主结构变化）时仍正常降级', async () => {
  const provider = createShadowProvider({
    skills: {
      list: async () => [
        { name: 'gone', description: '描述', source: 'custom', path: '/x/gone/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      ],
    },
    scope: { name: 'preset-1' },
    providerName: 'workspace-scope',
    resolvePolicy: async () => ({ stateOf: (name) => (name === 'gone' ? 'off' : 'pinned') }),
  });

  const rows = await provider.list({ cwd: '/x' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].invocation, { modelInvocable: false, userInvocable: false });
});

test('list：内层读期间 collectCache 被并发调用换掉时，不去动别人的表', async () => {
  const original = new Map();
  const swapped = new Map([['x', 1]]);
  const provider = createShadowProvider({
    skills: {
      collectCache: original,
      async list() {
        // 模拟并发：字段在 await 期间被换掉。
        this.collectCache = swapped;
        return [];
      },
    },
    scope: { name: 'preset-1' },
    providerName: 'workspace-scope',
    resolvePolicy: async () => ({ stateOf: () => 'pinned' }),
  });

  assert.deepEqual(await provider.list({ cwd: '/x' }), []);
  assert.equal(swapped.has('x'), true, '不碰并发换上的那张表');
});
