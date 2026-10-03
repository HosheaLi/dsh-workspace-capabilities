/**
 * mcp.js 的单元测试：工具名解析与 deny 名单推导。
 *
 * 纯 JS，无宿主依赖。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpRestrictor, denyNamesFor, mcpServerOf, mcpServersOf } from '../lib/mcp.js';

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

// ── restrict 施加器：三段式防护 + 代际补偿 ──────────────────────────────────

/**
 * 造一个施加器与它的 agent 替身。
 * @param options - `{ deny, tools, logger, onRestrict }`。
 */
function makeRestrictor({ deny = ['mcp__comfy__generate'], tools, warn } = {}) {
  const calls = { restrict: [], warn: warn ?? [] };
  const scopedTools = tools ?? {
    restrict: ({ deny: list }) => {
      calls.restrict.push([...list]);
      return () => {};
    },
  };
  const restrictor = createMcpRestrictor({
    denyNamesFor: typeof deny === 'function' ? deny : async () => deny,
    logger: { warn: (...args) => calls.warn.push(args.join(' ')) },
  });
  const agent = { id: 'agent-1', ctx: { get: (service) => (service === 'tools' ? scopedTools : undefined) } };
  return { restrictor, agent, calls, scopedTools };
}

test('apply：首次施加 deny，名单没变时不动（集合比较），变了才重装', async () => {
  let deny = ['mcp__comfy__generate'];
  const disposers = [];
  const { restrictor, agent, calls } = makeRestrictor({
    deny: async () => deny,
    tools: { restrict: ({ deny: list }) => { calls.restrict.push([...list]); const dispose = () => disposers.push([...list]); disposers.push; return () => { disposers.push('disposed'); }; } },
  });

  await restrictor.apply(agent);
  assert.deepEqual(calls.restrict, [['mcp__comfy__generate']], '首次按名单施加');

  await restrictor.apply(agent);
  assert.equal(calls.restrict.length, 1, '名单逐项相同时不该重复施加');

  deny = ['mcp__comfy__generate', 'mcp__comfy__list'];
  await restrictor.apply(agent);
  assert.equal(disposers.length, 1, '名单变化时先撤销旧限制');
  assert.deepEqual(calls.restrict.at(-1), ['mcp__comfy__generate', 'mcp__comfy__list']);

  deny = [];
  await restrictor.apply(agent);
  assert.equal(disposers.length, 2, '名单清空也要撤销');
  assert.equal(calls.restrict.length, 2, '名单为空时不建立新限制');
});

test('apply：restrict 同步回调自己不递归（哨兵），无 scoped tools 时安全返回', async () => {
  let nested = 0;
  const { restrictor, agent, calls } = makeRestrictor({
    tools: {
      restrict: ({ deny: list }) => {
        calls.restrict.push([...list]);
        // 真实 `tools.restrict` 会同步 emit tools/change → 触发一次重入 apply
        void restrictor.apply(agent).then(() => { nested += 1; });
        return () => {};
      },
    },
  });
  await restrictor.apply(agent);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.restrict.length, 1, '重入必须被哨兵挡下，不能无限递归');

  const noTools = createMcpRestrictor({ denyNamesFor: async () => ['x'], logger: { warn: () => {} } });
  await noTools.apply({ id: 'no-tools', ctx: { get: () => undefined } });
  await noTools.apply(undefined);
  await noTools.apply(null);
});

test('apply：代际补偿 —— 读盘期间工具面变了就重算，而不是漏 deny', async () => {
  let round = 0;
  const calls = { restrict: [] };
  const restrictor = createMcpRestrictor({
    denyNamesFor: async () => {
      round += 1;
      if (round === 1) restrictor.noteChange(); // 模拟 await 期间 MCP 工具又注册进来
      return ['mcp__comfy__generate'];
    },
    logger: { warn: () => {} },
  });
  const agent = { id: 'agent-1', ctx: { get: () => ({ restrict: ({ deny }) => { calls.restrict.push([...deny]); return () => {}; } }) } };

  await restrictor.apply(agent);
  assert.equal(round, 2, '代际变了必须重算一次');
  assert.equal(calls.restrict.length, 1, '重算后只施加一次');
});

test('apply / disposeAll：失败只告警不抛，forget 后视为全新 agent', async () => {
  const warn = [];
  // denyNamesFor 抛错（例如 restrict 不认识的工具名）
  const failing = createMcpRestrictor({ denyNamesFor: async () => { throw new Error('unknown global tool'); }, logger: { warn: (...a) => warn.push(a.join(' ')) } });
  await failing.apply({ id: 'agent-x', ctx: { get: () => ({ restrict: () => () => {} }) } });
  assert.match(warn.join('\n'), /MCP 屏蔽失败/);

  // 撤销旧限制时 disposer 抛错
  const boom = [];
  let deny = ['a'];
  const restrictor = createMcpRestrictor({
    denyNamesFor: async () => deny,
    logger: { warn: (...a) => boom.push(a.join(' ')) },
  });
  const agent = { id: 'agent-1', ctx: { get: () => ({ restrict: () => () => { throw new Error('dispose 爆炸'); } }) } };
  await restrictor.apply(agent);
  deny = ['b'];
  await restrictor.apply(agent);
  assert.match(boom.join('\n'), /撤销旧 MCP 限制失败/);

  // 卸载：disposeAll 撤销全部，抛错同样只告警
  restrictor.disposeAll();
  assert.match(boom.join('\n'), /卸载时撤销 MCP 限制失败/);

  // forget 清账：同一 id 再次 apply 视为首次
  restrictor.forget('agent-1');
  const calls = [];
  const again = createMcpRestrictor({ denyNamesFor: async () => ['a'], logger: { warn: () => {} } });
  await again.apply({ id: 'agent-1', ctx: { get: () => ({ restrict: ({ deny: list }) => { calls.push([...list]); return () => {}; } }) } });
  again.forget('agent-1');
  await again.apply({ id: 'agent-1', ctx: { get: () => ({ restrict: ({ deny: list }) => { calls.push([...list]); return () => {}; } }) } });
  assert.equal(calls.length, 2, 'forget 之后应重新施加');
});

test('noteChange：推进代际让在途 apply 重算', async () => {
  const { restrictor, agent, calls } = makeRestrictor();
  restrictor.noteChange();
  await restrictor.apply(agent);
  assert.deepEqual(calls.restrict, [['mcp__comfy__generate']]);
});
