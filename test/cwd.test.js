/**
 * cwd.js 的单元测试：当前工作目录的优先级与全部退化路径。
 *
 * 这条函数是「会话内 cd」适配的单一入口，退化必须静默 —— 目录解析失败不该让
 * 技能枚举或 MCP 补偿整条断掉。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { effectiveCwdOf } from '../lib/cwd.js';

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
