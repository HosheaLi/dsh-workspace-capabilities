/**
 * catalog.js 的单元测试：frontmatter 剥离、可管理性判定、来源兜底，以及目录枚举的
 * 三个视图与"只认 cwd 匹配的 agent"。
 *
 * 纯函数 + stub ctx，无宿主依赖。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogCharsOf,
  CATALOG_DESCRIPTION_MAX_LENGTH,
  collectCatalog,
  compareCatalogRows,
  inModelCatalog,
  MANAGEABLE_SOURCES,
  manageabilityOf,
  sourceLabelOf,
  sourceRankOf,
  SOURCE_LABELS,
  SOURCE_ORDER,
  stripFrontmatter,
  toCatalogRow,
} from '../lib/catalog.js';

test('SOURCE_ORDER 与 SOURCE_LABELS 必须一一对应（加来源时别漏配显示名）', () => {
  assert.deepEqual([...SOURCE_ORDER].sort(), Object.keys(SOURCE_LABELS).sort(), '两个表必须描述同一组来源');
  assert.equal(new Set(SOURCE_ORDER).size, SOURCE_ORDER.length, '顺序表里不该有重复');
  // 前五项与 dsh-skill-filesystem 的 rank 同序：面板顺序 = 同名冲突时的实际优先级
  assert.deepEqual(SOURCE_ORDER.slice(0, 5), ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents']);
});

test('sourceRankOf：已知来源按顺序，未知/空/非字符串排最后', () => {
  assert.equal(sourceRankOf('project-dsh'), 0);
  assert.equal(sourceRankOf('runtime'), SOURCE_ORDER.length - 1);
  assert.equal(sourceRankOf('bundled') < sourceRankOf('runtime'), true, '包内置排在运行时注册之前');
  for (const unknown of ['自造来源', '', undefined, 42]) {
    assert.equal(sourceRankOf(unknown), SOURCE_ORDER.length, `未知来源 ${String(unknown)} 必须排最后`);
  }
});

test('compareCatalogRows：可管理优先 → 来源 → 名称', () => {
  const row = (name, source, manageable = true) => ({ name, source, manageable, sourceLabel: sourceLabelOf(source) });
  const sorted = [
    row('zeta', 'user-agents'),
    row('beta', 'bundled', false),
    row('alpha', 'project-agents'),
    row('runtime-c', 'runtime', false),
    row('alpha', 'project-dsh'),
    row('mystery', '自造来源'),
    row('beta', 'project-dsh'),
    row('ghost', '自造来源', false),
  ].sort(compareCatalogRows);

  assert.deepEqual(sorted.map((entry) => `${entry.name}@${entry.source}`), [
    // 可管理组：项目 → 自定义 → 用户 → 未知来源
    'alpha@project-dsh',
    'beta@project-dsh',
    'alpha@project-agents',
    'zeta@user-agents',
    'mystery@自造来源',
    // 不可管理组：同样是来源优先，未知来源仍排最后
    'beta@bundled',
    'runtime-c@runtime',
    'ghost@自造来源',
  ]);
  assert.equal(compareCatalogRows(row('a', 'custom'), row('a', 'custom')), 0, '同键必须相等，排序才是稳定的');
});

test('catalogCharsOf：复刻宿主渲染规则（空白折叠、500 字符截断、不进目录时为 0）', () => {
  const base = { name: 'demo', invocation: { modelInvocable: true } };
  assert.equal(catalogCharsOf({ ...base, description: '描述' }), '- `demo`: 描述'.length + 1);
  assert.equal(catalogCharsOf({ ...base, description: 'a\n\n  b ' }), '- `demo`: a b'.length + 1, '空白要折叠成一个空格');
  const long = 'x'.repeat(CATALOG_DESCRIPTION_MAX_LENGTH + 50);
  const clipped = catalogCharsOf({ ...base, description: long });
  assert.equal(clipped, `- \`demo\`: ${'x'.repeat(CATALOG_DESCRIPTION_MAX_LENGTH - 3)}...`.length + 1, '超长描述按宿主的 500 字符上限截断');
  assert.equal(catalogCharsOf({ ...base, invocation: { modelInvocable: false }, description: '描述' }), 0, '模型不可调用的技能永远不进目录');
  assert.equal(catalogCharsOf({ ...base, description: undefined }), '- `demo`: '.length + 1, '缺描述按空串算');
});

test('inModelCatalog：可管理行只有 pinned 进目录，不可管理行看注册表', () => {
  const row = (extra) => ({ name: 'demo', manageable: true, state: 'pinned', invocation: { modelInvocable: true }, ...extra });
  assert.equal(inModelCatalog(row({})), true);
  assert.equal(inModelCatalog(row({ state: 'manual' })), false, 'manual 被 shadow provider 摘出目录');
  assert.equal(inModelCatalog(row({ state: 'off' })), false);
  assert.equal(inModelCatalog(row({ invocation: { modelInvocable: false } })), false, 'disable-model-invocation 的技能不进目录');
  // 不可管理行本插件不接管：state 对它没有意义，注册表说可见就可见
  assert.equal(inModelCatalog(row({ manageable: false, state: 'off' })), true);
  assert.equal(inModelCatalog(row({ manageable: false, invocation: { modelInvocable: false } })), false);
});

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
