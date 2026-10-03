/**
 * mcp.js 的单元测试：工具名解析与 deny 名单推导。
 *
 * 纯 JS，无宿主依赖。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { denyNamesFor, mcpServerOf, mcpServersOf } from '../lib/mcp.js';

test('mcpServerOf：基本解析与非法输入', () => {
  assert.equal(mcpServerOf('mcp__comfy__generate'), 'comfy');
  assert.equal(mcpServerOf('bash'), undefined, '非 MCP 工具返回 undefined');
  assert.equal(mcpServerOf('mcp__comfy'), undefined, '缺 rawName 段');
  assert.equal(mcpServerOf('mcp____x'), undefined, '空 serverName');
  assert.equal(mcpServerOf(undefined), undefined);
});

test('mcpServerOf：serverName 含 __ 时按已知服务器名做最长匹配', () => {
  // 官方 SERVER_NAME_PATTERN 允许 serverName 含 `__`，取第一段会解析成 `my`，
  // 配置里的 `my__server` 匹配不上 → 开关静默失效。
  const name = 'mcp__my__server__do_thing';
  assert.equal(mcpServerOf(name), 'my', '无候选可比时退化为取第一段');
  assert.equal(mcpServerOf(name, ['my__server']), 'my__server', '有已知名时必须最长匹配');
  assert.equal(mcpServerOf(name, ['my', 'my__server']), 'my__server', '候选里有前缀关系时取最长');
  assert.equal(mcpServerOf(name, ['other']), 'my', '已知名都不匹配时仍退化');
});

test('mcpServersOf：去重并排序', () => {
  const schemas = [{ name: 'mcp__b__one' }, { name: 'mcp__a__two' }, { name: 'bash' }, { name: 'mcp__b__three' }];
  assert.deepEqual(mcpServersOf(schemas), ['a', 'b']);
  assert.deepEqual(mcpServersOf(schemas, ['b']), ['a', 'b']);
  assert.deepEqual(mcpServersOf(undefined), []);
});

test('denyNamesFor：按服务器开关剔除工具，且 respect 已知服务器名', () => {
  const schemas = [{ name: 'mcp__comfy__generate' }, { name: 'mcp__other__search' }, { name: 'bash' }];
  assert.deepEqual(denyNamesFor(schemas, (server) => server !== 'comfy'), ['mcp__comfy__generate']);
  assert.deepEqual(denyNamesFor(schemas, () => true), [], '全部启用时不 deny 任何东西');
  assert.deepEqual(denyNamesFor(undefined, () => false), []);

  // serverName 含 `__`：不传已知名时 deny 名单为空（开关静默失效），传了才正确。
  const tricky = [{ name: 'mcp__my__server__do_thing' }];
  assert.deepEqual(denyNamesFor(tricky, (server) => server !== 'my__server'), []);
  assert.deepEqual(denyNamesFor(tricky, (server) => server !== 'my__server', ['my__server']), ['mcp__my__server__do_thing']);
});
