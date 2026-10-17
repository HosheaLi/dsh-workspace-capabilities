/**
 * cwd.js 的单元测试：当前工作目录的优先级与全部退化路径。
 *
 * 这条函数是「会话内 cd」适配的单一入口，退化必须静默 —— 目录解析失败不该让
 * 技能枚举或 MCP 补偿整条断掉。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { agentScopeMatch, effectiveCwdOf, scopeRootOf } from '../lib/cwd.js';

/** 造一个最小 agent（只带 session）。 */
const agentOf = (cwd) => ({ id: 'ses-a', session: { header: { cwd } } });

test('effectiveCwdOf：优先 workingDirectory 的投影目录（会话内 cd 后的当前目录）', () => {
  const agent = agentOf('/initial');
  const ctx = { get: (name) => (name === 'workingDirectory' ? { get: () => '/current' } : undefined) };
  assert.equal(effectiveCwdOf(ctx, agent), '/current', '当前目录必须压过 session.header.cwd');
});

test('effectiveCwdOf：没有 workingDirectory 服务时回落到 session.header.cwd', () => {
  assert.equal(effectiveCwdOf({ get: () => undefined }, agentOf('/initial')), '/initial');
  assert.equal(effectiveCwdOf(undefined, agentOf('/initial')), '/initial', 'ctx 缺失也要能取值');
});

test('effectiveCwdOf：服务返回值不可用时回落 header（空串 / 非字符串 / 缺 get）', () => {
  for (const broken of ['', 42, null, undefined]) {
    const ctx = { get: () => ({ get: () => broken }) };
    assert.equal(effectiveCwdOf(ctx, agentOf('/initial')), '/initial', `服务返回 ${String(broken)} 时必须回落`);
  }
  const noGetter = { get: () => ({}) };
  assert.equal(effectiveCwdOf(noGetter, agentOf('/initial')), '/initial', '服务没有 get() 时回落');
});

test('effectiveCwdOf：服务读取抛错时回落 header，不向上抛', () => {
  const ctx = { get: () => ({ get: () => { throw new Error('projection not ready'); } }) };
  assert.equal(effectiveCwdOf(ctx, agentOf('/initial')), '/initial');
  const badCtx = { get: () => { throw new Error('service store exploded'); } };
  assert.equal(effectiveCwdOf(badCtx, agentOf('/initial')), '/initial', 'ctx.get 抛错同样只能回落');
});

test('effectiveCwdOf：连 header 都没有时返回 undefined', () => {
  assert.equal(effectiveCwdOf(undefined, undefined), undefined);
  assert.equal(effectiveCwdOf(undefined, { session: null }), undefined);
  assert.equal(effectiveCwdOf(undefined, { session: {} }), undefined);
  assert.equal(effectiveCwdOf(undefined, { session: { header: {} } }), undefined);
  assert.equal(effectiveCwdOf(undefined, { session: { header: { cwd: 123 } } }), undefined, 'header.cwd 非字符串不算数');
});

/** 临时目录：`<base>/project/.git` + `<base>/project/src` + `<base>/other`（无 .git）。 */
async function makeRoots() {
  const base = await mkdtemp(join(tmpdir(), 'wscope-cwd-'));
  const project = join(base, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(join(base, 'other'), { recursive: true });
  return { base, project, sub: join(project, 'src'), other: join(base, 'other') };
}

test('scopeRootOf：当前目录解析到项目根，子目录与项目根同作用域', async () => {
  const { base, project, sub, other } = await makeRoots();
  try {
    const ctx = { get: () => ({ get: () => sub }) };
    assert.equal(await scopeRootOf(ctx, agentOf(project)), project, '子目录 cd 后作用域仍是项目根');
    assert.equal(await scopeRootOf(undefined, agentOf(project)), project, '没有 workingDirectory 服务时用 header 解析');
    assert.equal(await scopeRootOf(undefined, agentOf(other)), other, '没有 .git 祖先时项目根就是目录自身');
    assert.equal(await scopeRootOf(undefined, { session: {} }), undefined, '没有目录时返回 undefined');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('agentScopeMatch：按项目根匹配，跨项目根与无效入参都不匹配', async () => {
  const { base, project, sub, other } = await makeRoots();
  try {
    const inSub = { id: 'ses-sub', session: { header: { cwd: project } } };
    const inOther = { id: 'ses-other', session: { header: { cwd: other } } };
    const noCwd = { id: 'ses-none', session: {} };
    const ctx = { get: () => ({ get: (session) => (session === inSub.session ? sub : undefined) }) };

    assert.deepEqual(
      await agentScopeMatch(ctx, project, [noCwd, inOther, inSub]),
      { agent: inSub, cwd: sub },
      '子目录 cd 的会话仍属于项目根，且返回它的当前目录',
    );
    assert.equal(await agentScopeMatch(ctx, other, [inSub]), undefined, '跨项目根不得借用');
    assert.equal(await agentScopeMatch(ctx, '', [inSub]), undefined, '空 cwd 不匹配');
    assert.equal(await agentScopeMatch(ctx, 42, [inSub]), undefined, '非字符串 cwd 不匹配');
    assert.equal(await agentScopeMatch(ctx, project, undefined), undefined, '没有候选时返回 undefined');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
