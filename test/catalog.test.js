/**
 * catalog.js 的单元测试：frontmatter 剥离、可管理性判定、来源兜底，以及目录枚举的
 * 三个视图与"只认 cwd 匹配的 agent"。
 *
 * 纯函数 + stub ctx，无宿主依赖。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectCatalog,
  MANAGEABLE_SOURCES,
  manageabilityOf,
  sourceLabelOf,
  SOURCE_LABELS,
  stripFrontmatter,
  toCatalogRow,
} from '../lib/catalog.js';

test('stripFrontmatter：剥掉 frontmatter 后 trim 正文，容忍 CRLF', () => {
  assert.equal(stripFrontmatter('---\nname: a\n---\n\n正文\n'), '正文');
  assert.equal(stripFrontmatter('---\r\nname: a\r\n---\r\n正文\r\n'), '正文');
  assert.equal(stripFrontmatter('---\nname: a\n---\n'), '', '空正文返回空串，而不是 undefined');
  // 无闭合行 / 无 frontmatter / 首行不是分隔符：一律拒绝加载
  assert.equal(stripFrontmatter('正文'), undefined);
  assert.equal(stripFrontmatter('---\nname: a\n'), undefined);
  assert.equal(stripFrontmatter(''), undefined);
  assert.equal(stripFrontmatter(undefined), undefined);
});

test('manageabilityOf：只接管正文在磁盘上的来源', () => {
  for (const source of MANAGEABLE_SOURCES) {
    assert.equal(manageabilityOf({ source, path: '/x/SKILL.md' }).manageable, true, source);
  }
  assert.equal(manageabilityOf({ source: 'bundled', path: '/x/SKILL.md' }).manageable, false, 'bundled 正文在包内 assets');
  assert.equal(manageabilityOf({ source: 'runtime', path: '/x/SKILL.md' }).manageable, false, 'runtime 正文靠运行时拼接');
  assert.equal(manageabilityOf({ source: 'custom' }).manageable, false, '缺 path 不可管理');
  // 回归：`SOURCE_LABELS[source] ?? source ?? '未知来源'` 在 source 为空串时兜不住，
  // 会渲染出缺主语的"技能正文不在磁盘上…"。
  assert.match(manageabilityOf({ source: undefined }).reason, /^未知来源技能正文不在磁盘上/);
});

test('sourceLabelOf：未知与缺失都回落到 未知来源', () => {
  assert.equal(sourceLabelOf('user-dsh'), SOURCE_LABELS['user-dsh']);
  assert.equal(sourceLabelOf('自造来源'), '自造来源');
  assert.equal(sourceLabelOf(''), '未知来源');
  assert.equal(sourceLabelOf(undefined), '未知来源');
});

test('toCatalogRow：可管理标记、来源显示名与 invocation 归一', () => {
  const row = toCatalogRow({
    name: 'demo',
    description: '描述',
    source: 'custom',
    path: '/x/demo/SKILL.md',
    invocation: { modelInvocable: true, userInvocable: false },
  });
  assert.equal(row.manageable, true);
  assert.equal(row.sourceLabel, SOURCE_LABELS.custom);
  assert.equal(row.path, '/x/demo/SKILL.md');
  assert.deepEqual(row.invocation, { modelInvocable: true, userInvocable: false });

  const unmanageable = toCatalogRow({ name: 'bundled', description: 'd', source: 'bundled' });
  assert.equal(unmanageable.manageable, false);
  assert.equal(unmanageable.sourceLabel, SOURCE_LABELS.bundled);
});

test('collectCatalog：agent 视图、preset 兜底、global 兜底，且只认 cwd 匹配的 agent', async () => {
  const rowsOf = (names) =>
    names.map((name) => ({ name, description: `${name} 的描述`, source: 'custom', path: `/x/${name}/SKILL.md`, invocation: { modelInvocable: true, userInvocable: true } }));

  /** stub host ctx：agents / agentPresets / skills 三个入口。 */
  const makeCtx = ({ agents = [], preset = undefined, globalRows = [], presetRows = [] } = {}) => ({
    get: (name) => {
      if (name === 'agents') return { list: () => agents };
      if (name === 'agentPresets') return preset;
      return undefined;
    },
    // preset 作用域的调用带 scope，global 兜底不带 —— 用它把两档分开。
    skills: { list: async (options) => (options?.scope === undefined ? globalRows : presetRows) },
  });

  const agentOf = (cwd) => ({
    id: `ses:${cwd}`,
    session: { header: { cwd } },
    ctx: { get: () => ({ list: async () => rowsOf(['agent-skill']) }) },
  });

  // 1) cwd 匹配的 agent：via=agent，完整视图
  const matched = await collectCatalog(makeCtx({ agents: [agentOf('/p')] }), { cwd: '/p' });
  assert.equal(matched.via, 'agent');
  assert.equal(matched.incomplete, false);
  assert.equal(matched.notice, undefined);
  assert.deepEqual(matched.rows.map((row) => row.name), ['agent-skill']);

  const preset = { acquireScope: async () => ({ key: 'preset-key', [Symbol.asyncDispose]: async () => {} }) };

  // 2) 有 agent 但 cwd 不匹配：不得借用它的视图，回落 preset 并给提示
  const stray = await collectCatalog(
    makeCtx({ agents: [agentOf('/p')], preset, presetRows: rowsOf(['preset-skill']), globalRows: rowsOf(['global-skill']) }),
    { cwd: '/other' },
  );
  assert.equal(stray.via, 'preset');
  assert.equal(stray.incomplete, true);
  assert.equal(stray.cwd, '/other', '返回的 cwd 必须是请求的那个工作区');
  assert.deepEqual(stray.rows.map((row) => row.name), ['preset-skill'], '不得混入别处 agent 的行');
  assert.match(stray.notice ?? '', /agent 层的降级/);

  // 3) 既没有 agent 也没有 preset：global 兜底 + 提示
  const globalView = await collectCatalog(makeCtx({ globalRows: rowsOf(['global-skill']) }), { cwd: '/other' });
  assert.equal(globalView.via, 'global');
  assert.equal(globalView.incomplete, true);
  assert.deepEqual(globalView.rows.map((row) => row.name), ['global-skill']);
  assert.match(globalView.notice ?? '', /全局层/);

  // 4) preset 可用但一行都没产出：不能谎报 via=preset，要落到 global
  const emptyPreset = await collectCatalog(
    makeCtx({ preset, presetRows: [], globalRows: rowsOf(['global-only']) }),
    { cwd: '/other' },
  );
  assert.equal(emptyPreset.via, 'global');
  assert.deepEqual(emptyPreset.rows.map((row) => row.name), ['global-only']);
  assert.match(emptyPreset.notice ?? '', /全局层/);
});

test('stripFrontmatter：只有分隔行、没有正文时也算拒绝', () => {
  // 首行 `---` 之后紧跟空行：循环自然走完（lineStart 越过长度），返回 undefined。
  assert.equal(stripFrontmatter('---\n\n'), undefined);
});

test('readSkillBody / fileSizeOf：读不到一律返回 undefined，不抛', async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileSizeOf, readSkillBody } = await import('../lib/catalog.js');

  const base = await mkdtemp(join(tmpdir(), 'wscope-catalog-'));
  try {
    const missing = join(base, 'nope.md');
    assert.equal(await readSkillBody(missing), undefined, '文件不存在');
    assert.equal(await readSkillBody(missing, new AbortController().signal), undefined, '带 signal 的路径同样安全');
    assert.equal(await readSkillBody(base), undefined, '路径是目录（EISDIR）也不抛');

    assert.equal(await fileSizeOf(base), undefined, '目录不算文件');
    assert.equal(await fileSizeOf(missing), undefined, '不存在的路径返回 undefined');

    const ok = join(base, 'ok.md');
    await writeFile(ok, '---\nname: a\ndescription: d\n---\n\n正文\n', 'utf8');
    assert.equal(await readSkillBody(ok), '正文');
    assert.equal(typeof await fileSizeOf(ok), 'number');

    const nested = join(base, 'deep', 'dir');
    await mkdir(nested, { recursive: true });
    assert.equal(await fileSizeOf(nested), undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
