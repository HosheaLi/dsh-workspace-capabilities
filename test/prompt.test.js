/**
 * prompt.js 的单元测试：按 agent 遮蔽 MCP 提示词段。
 *
 * 纯 JS，无宿主依赖（用假 agent / 假 systemPrompt 服务）。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptMasker, mcpSectionName } from '../lib/prompt.js';

/** 造一个记录注册的假 systemPrompt 服务。 */
function createFakeSystemPrompt({ order = 1200 } = {}) {
  /** @type {Map<string, object>} */
  const sections = new Map();
  const disposed = [];
  return {
    sections,
    disposed,
    getSectionOrder(name) {
      assert.equal(name, 'MCP_SERVERS', '必须复用 mcp-client 的排序位置名');
      return order;
    },
    section(section) {
      sections.set(section.name, section);
      return () => {
        sections.delete(section.name);
        disposed.push(section.name);
      };
    },
  };
}

/** 造一个只暴露 systemPrompt 的假 agent。 */
function createFakeAgent(id, systemPrompt) {
  return {
    id,
    ctx: {
      get(name) {
        return name === 'systemPrompt' ? systemPrompt : undefined;
      },
    },
  };
}

test('mcpSectionName：与 dsh-mcp-client 的段名一致', () => {
  assert.equal(mcpSectionName('rea'), 'mcp:rea');
  assert.equal(mcpSectionName('my__server'), 'mcp:my__server');
});

test('apply：显式 false 的服务器注册空文本遮蔽段', () => {
  const systemPrompt = createFakeSystemPrompt();
  const agent = createFakeAgent('a1', systemPrompt);
  const masker = createPromptMasker();

  masker.apply(agent, { mcp: { rea: false } });

  assert.deepEqual([...systemPrompt.sections.keys()], ['mcp:rea']);
  const section = systemPrompt.sections.get('mcp:rea');
  assert.equal(section.order, 1200);
  assert.equal(section.text, '', '空段会在 renderPrompt 阶段被丢弃');
  assert.equal(section.interpolate, false, '空段不需要插值');
});

test('apply：true 与未出现的服务器都不遮蔽', () => {
  const systemPrompt = createFakeSystemPrompt();
  const agent = createFakeAgent('a1', systemPrompt);
  const masker = createPromptMasker();

  masker.apply(agent, { mcp: { rea: true, comfy: undefined } });

  assert.deepEqual([...systemPrompt.sections.keys()], [], 'enabled 不是 false 就不该遮蔽');
});

test('apply：幂等 —— 重复调用不重复注册', () => {
  const systemPrompt = createFakeSystemPrompt();
  const agent = createFakeAgent('a1', systemPrompt);
  const masker = createPromptMasker();

  masker.apply(agent, { mcp: { rea: false } });
  masker.apply(agent, { mcp: { rea: false } });
  masker.apply(agent, { mcp: { rea: false } });

  assert.deepEqual([...systemPrompt.sections.keys()], ['mcp:rea']);
  assert.equal(systemPrompt.disposed.length, 0, '重复 apply 不该触发卸载');
});

test('apply：策略翻转时增删差异，而不是全量重建', () => {
  const systemPrompt = createFakeSystemPrompt();
  const agent = createFakeAgent('a1', systemPrompt);
  const masker = createPromptMasker();

  masker.apply(agent, { mcp: { rea: false, comfy: false } });
  assert.deepEqual([...systemPrompt.sections.keys()].sort(), ['mcp:comfy', 'mcp:rea']);

  // rea 解禁、pencil 关闭：只应删 rea、加 pencil，comfy 保持不动。
  masker.apply(agent, { mcp: { rea: true, comfy: false, pencil: false } });
  assert.deepEqual([...systemPrompt.sections.keys()].sort(), ['mcp:comfy', 'mcp:pencil']);
  assert.deepEqual(systemPrompt.disposed, ['mcp:rea']);
});

test('apply：多个 agent 的遮蔽集互相独立', () => {
  const systemPrompt = createFakeSystemPrompt();
  const a1 = createFakeAgent('a1', systemPrompt);
  const a2 = createFakeAgent('a2', systemPrompt);
  const masker = createPromptMasker();

  masker.apply(a1, { mcp: { rea: false } });
  masker.apply(a2, { mcp: {} });

  // 假 systemPrompt 是共享实例，这里验证的是"登记表按 agent 分开"：
  // 给 a2 关掉 rea 不改变 a1 已有登记，反之亦然。
  assert.deepEqual([...systemPrompt.sections.keys()], ['mcp:rea']);
  masker.forget('a1');
  masker.apply(a2, { mcp: { rea: false } });
  assert.deepEqual([...systemPrompt.sections.keys()], ['mcp:rea'], 'a2 自己的遮蔽仍然生效');
});

test('apply：宿主没有 systemPrompt 服务时静默跳过', () => {
  const masker = createPromptMasker();
  const agent = { id: 'a1', ctx: { get: () => undefined } };
  assert.doesNotThrow(() => masker.apply(agent, { mcp: { rea: false } }));
  assert.doesNotThrow(() => masker.apply(undefined, { mcp: { rea: false } }));
  assert.doesNotThrow(() => masker.apply({ id: 'x' }, { mcp: { rea: false } }));
});

test('apply：section 抛错只记日志，不向调用方传播', () => {
  const warnings = [];
  const agent = createFakeAgent('a1', {
    getSectionOrder: () => 1200,
    section() {
      throw new Error('boom');
    },
  });
  const masker = createPromptMasker({ logger: { warn: (m) => warnings.push(m) } });

  assert.doesNotThrow(() => masker.apply(agent, { mcp: { rea: false } }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rea|同步提示词遮蔽/);
});

test('disposeAll：全部卸载并清空登记表', () => {
  const systemPrompt = createFakeSystemPrompt();
  const agent = createFakeAgent('a1', systemPrompt);
  const masker = createPromptMasker();

  masker.apply(agent, { mcp: { rea: false, comfy: false } });
  masker.disposeAll();

  assert.deepEqual([...systemPrompt.sections.keys()], []);
  assert.equal(systemPrompt.disposed.length, 2);

  // 卸载后再 apply 仍能工作（登记表已清空）。
  masker.apply(agent, { mcp: { rea: false } });
  assert.deepEqual([...systemPrompt.sections.keys()], ['mcp:rea']);
});
