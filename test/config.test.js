/**
 * config.js 的单元测试：路径分离、匹配优先级、两级合并、原子写与读-改-写。
 *
 * 跑法：`npm test`（等价于 `node --test` + 测试文件 glob）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_STATE,
  dshHome,
  emptyConfig,
  findProjectRoot,
  globalConfigPath,
  globToRegExp,
  matchedKeyOf,
  mergeConfig,
  normalizeConfig,
  projectConfigPath,
  readConfigFile,
  resolveScope,
  serializeConfig,
  skillStateOf,
  updateConfigFile,
  withDefaultState,
  withMcpEnabled,
  withSkillState,
  withoutMcpEntry,
  withoutSkillState,
  writeConfigFile,
} from '../lib/config.js';

test('全局配置路径与项目配置路径不重合', () => {
  const home = dshHome({ DSH_HOME: '/tmp/fake-dsh-home' });
  assert.equal(home, '/tmp/fake-dsh-home');
  const global = globalConfigPath({ DSH_HOME: '/tmp/fake-dsh-home' });
  const project = projectConfigPath('/tmp/fake-dsh-home');
  assert.equal(global, '/tmp/fake-dsh-home/settings/skills-scope.json');
  assert.equal(project, '/tmp/fake-dsh-home/.dsh/skills-scope.json');
  assert.notEqual(global, project);
});

test('findProjectRoot 取最近的 .git 祖先，没有则兜底返回 cwd', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wscope-root-'));
  try {
    const repo = join(base, 'repo');
    const nested = join(repo, 'a', 'b');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });
    assert.equal(await findProjectRoot(nested), repo);

    const loose = join(base, 'loose', 'x');
    await mkdir(loose, { recursive: true });
    assert.equal(await findProjectRoot(loose), loose);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('项目根等于 home 时跳过项目层并给出说明', async () => {
  const scope = await resolveScope(homedir(), {});
  assert.equal(scope.projectLayer, false);
  assert.equal(scope.projectPath, undefined);
  assert.match(scope.notice ?? '', /跳过项目层/);
});

test('normalizeConfig 丢弃未知形状', () => {
  const config = normalizeConfig({
    version: 99,
    default: 'manual',
    skills: { good: 'off', bad: 'nope', default: 'off', '': 'off' },
    mcp: { comfy: false, other: 'yes' },
    extra: 1,
  });
  // 名为 `default` 的技能是合法技能名（与顶层 default 不是同一个键），必须保留。
  assert.deepEqual(config.skills, { good: 'off', default: 'off' });
  assert.deepEqual(config.mcp, { comfy: false });
  assert.equal(config.default, 'manual');
  assert.equal(normalizeConfig(null).default, undefined);
  assert.equal(normalizeConfig('x').skills && Object.keys(normalizeConfig('x').skills).length, 0);
});

test('通配符编译：* 任意长度、? 单字符、其余按字面量', () => {
  assert.ok(globToRegExp('comfy-*').test('comfy-image'));
  assert.ok(!globToRegExp('comfy-*').test('xcomfy-image'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(!globToRegExp('a?c').test('abbc'));
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('匹配优先级：精确名 > 最长通配符 > default', () => {
  const effective = mergeConfig({ default: 'pinned', skills: { 'comfy-*': 'off', 'comfy-edit*': 'manual', exact: 'manual' }, mcp: {} });
  assert.equal(skillStateOf(effective, 'exact'), 'manual');
  assert.equal(skillStateOf(effective, 'comfy-edit-image'), 'manual');
  assert.equal(skillStateOf(effective, 'comfy-image'), 'off');
  assert.equal(skillStateOf(effective, 'other'), 'pinned');

  assert.deepEqual(matchedKeyOf(effective, 'comfy-edit-image'), { key: 'comfy-edit*', state: 'manual' });
  assert.deepEqual(matchedKeyOf(effective, 'other'), { key: undefined, state: 'pinned' });
});

test('两级合并：项目层逐键覆盖全局层，default 同理', () => {
  const globalConfig = normalizeConfig({ default: 'manual', skills: { a: 'off', b: 'manual' }, mcp: { comfy: false } });
  const projectConfig = normalizeConfig({ skills: { b: 'pinned' }, mcp: { comfy: true } });
  const effective = mergeConfig(globalConfig, projectConfig);
  assert.deepEqual(effective.skills, { a: 'off', b: 'pinned' });
  assert.deepEqual(effective.mcp, { comfy: true });
  assert.equal(effective.default, 'manual');
  assert.equal(mergeConfig(emptyConfig(), emptyConfig()).default, DEFAULT_STATE);
});

test('不可变编辑函数不修改入参', () => {
  const base = normalizeConfig({ skills: { a: 'off' }, mcp: { s: false } });
  const after = withSkillState(base, 'b', 'manual');
  assert.deepEqual(after.skills, { a: 'off', b: 'manual' });
  assert.deepEqual(base.skills, { a: 'off' });
  assert.deepEqual(withoutSkillState(after, 'a').skills, { b: 'manual' });
  assert.deepEqual(withMcpEnabled(base, 's', true).mcp, { s: true });
  assert.deepEqual(withoutMcpEntry(base, 's').mcp, {});
  assert.equal(withDefaultState(base, 'off').default, 'off');
});

test('序列化稳定：键排序、固定缩进、末尾换行', () => {
  const text = serializeConfig(normalizeConfig({ skills: { b: 'off', a: 'manual' }, mcp: { z: true, a: false } }));
  assert.equal(
    text,
    '{\n  "version": 1,\n  "skills": {\n    "a": "manual",\n    "b": "off"\n  },\n  "mcp": {\n    "a": false,\n    "z": true\n  }\n}\n',
  );
});

test('未显式设置 default 时不落盘：否则项目层会物化出 default 盖掉全局设置', async () => {
  // 回归：曾经 `serializeConfig` 缺省写 `"default": "pinned"`，于是"在项目里关掉一个技能"
  // 会顺带把全局 default=manual 覆盖掉，本该不进模型目录的技能重新自动注入。
  const globalConfig = normalizeConfig({ default: 'manual' });
  const projectText = serializeConfig(withSkillState(emptyConfig(), 'x', 'off'));
  assert.equal(projectText.includes('"default"'), false, '没有显式 default 就不该写这个键');
  assert.equal(mergeConfig(globalConfig, normalizeConfig(JSON.parse(projectText))).default, 'manual');

  const explicit = serializeConfig(withDefaultState(emptyConfig(), 'off'));
  assert.match(explicit, /"default": "off"/, '显式设置过 default 必须落盘');
});

test('updateConfigFile：链内读-改-写，并发写不丢更新', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wscope-update-'));
  try {
    const path = join(base, 'nested', 'skills-scope.json');
    // 两次"快速点击"：各自 mutate 只加自己那条，基线必须是链内最新文件。
    await Promise.all([
      updateConfigFile(path, (config) => withSkillState(config, 'first', 'off')),
      updateConfigFile(path, (config) => withSkillState(config, 'second', 'manual')),
    ]);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(parsed.skills, { first: 'off', second: 'manual' }, '两次写必须都留下');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('updateConfigFile：保留未知顶层键与已有 default，不静默丢弃', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wscope-keep-'));
  try {
    const path = join(base, 'skills-scope.json');
    await writeFile(path, `${JSON.stringify({ version: 1, default: 'manual', futureField: { keep: true }, skills: { a: 'off' }, mcp: {} }, undefined, 2)}\n`, 'utf8');
    await updateConfigFile(path, (config) => withSkillState(config, 'b', 'manual'));
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(parsed.futureField, { keep: true }, '未知顶层键（更新版本写入的字段）必须原样保留');
    assert.equal(parsed.default, 'manual', '已有 default 必须保留');
    assert.deepEqual(parsed.skills, { a: 'off', b: 'manual' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('updateConfigFile：损坏文件拒写并报错，原文件不被空配置覆盖', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wscope-broken-'));
  try {
    const path = join(base, 'skills-scope.json');
    await writeFile(path, '{ not json', 'utf8');
    await assert.rejects(() => updateConfigFile(path, (config) => withSkillState(config, 'x', 'off')), /不是合法 JSON/);
    assert.equal(await readFile(path, 'utf8'), '{ not json', '拒写时文件必须原样保留');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('读缺失/损坏文件都降级，损坏时带 error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wscope-read-'));
  try {
    const missing = await readConfigFile(join(base, 'nope.json'));
    assert.equal(missing.exists, false);
    assert.equal(missing.error, undefined);

    const broken = join(base, 'broken.json');
    await writeFile(broken, '{ not json', 'utf8');
    const read = await readConfigFile(broken);
    assert.equal(read.exists, true);
    assert.match(read.error ?? '', /JSON 解析失败/);
    assert.deepEqual(read.config.skills, {});
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('原子写：并发写同一路径后文件是完整 JSON，且不留 tmp', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wscope-write-'));
  try {
    const path = join(base, 'nested', 'skills-scope.json');
    const writes = [];
    for (let i = 0; i < 12; i += 1) {
      writes.push(writeConfigFile(path, normalizeConfig({ skills: { [`skill-${i}`]: 'off' } })));
    }
    await Promise.all(writes);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(Object.keys(parsed.skills).length, 1);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual((await readdir(join(base, 'nested'))).filter((name) => name.includes('.tmp-')), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
