/**
 * 研究探针：技能目录（<available_skills>）在真实 0.2.0-rc.2 运行时里的发布语义。
 *
 * 不属于 `npm test`（它验证的是宿主行为，不是本插件行为）；用途是复核
 * `docs/architecture.md` 第 2 节的实测结论。
 * 跑法：DSH_RUNTIME_DIR=/tmp/dshref/runtime node tools/probe-skill-catalog-publish.mjs
 *
 * 复刻 dsh-agent-loop 的 pre-step 调用方式（`waterfall('agent/pre-step', payload, next)`），
 * 组合真实 dsh-tools / dsh-skill / dsh-skill-filesystem / dsh-tool-skill + 本插件，
 * 用最小替身 session 记录每次 pre-step 实际产生的消息。
 *
 * 目标事实：
 *  1. 首次发布是"追加"一条 user 消息；
 *  2. 目录变化后发布的是 renderCatalogUpdate —— 追加 or 就地替换？含全量还是增量？
 *  3. 目录没变时是否静默（不产生消息）。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import * as plugin from '../lib/index.js';

const RUNTIME = process.env.DSH_RUNTIME_DIR ?? '/tmp/dshref/runtime';
const load = (pkg, rel = 'lib/index.js') => import(pathToFileURL(join(RUNTIME, 'node_modules', pkg, rel)).href);

const [{ Context }, scope, skillPlugin, fsPlugin, toolsModule, skillToolPlugin, llm] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-scope'),
  load('@deepseek-ai/dsh-skill'),
  load('@deepseek-ai/dsh-skill-filesystem'),
  load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-tool-skill'),
  load('@deepseek-ai/dsh-llm'),
]);

async function writeSkill(root, name, { description = `${name} 的描述` } = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), ['---', `name: ${name}`, `description: ${description}`, '---', '', '正文'].join('\n'), 'utf8');
}

/** 最小 session 替身：catalogHistory 需要 seq / surface.nodes / eventAt。 */
function createSession(cwd) {
  const events = [];
  const nodes = [];
  return {
    header: { cwd },
    events,
    nodes,
    get seq() { return events.length; },
    surface: { nodes },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => undefined,
    append(type, data) {
      const seq = events.length;
      events.push({ type, data, seq });
      nodes.push(seq);
      return { seq };
    },
  };
}

const base = await mkdtemp(join(tmpdir(), 'probe-catalog-'));
const dshHome = join(base, 'dsh-home');
const projectDir = join(base, 'project');
const customDir = join(base, 'custom');
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;
for (const dir of [join(dshHome, 'settings'), join(dshHome, 'skills'), join(projectDir, '.git'), join(projectDir, '.dsh', 'skills'), customDir]) {
  await mkdir(dir, { recursive: true });
}
for (const name of ['alpha-skill', 'beta-skill', 'gamma-skill']) await writeSkill(join(projectDir, '.dsh', 'skills'), name);

const root = new Context();
const session = createSession(projectDir);
const agent = { id: 'ses-a', session };
const agents = [agent];
root.provide('agents', { list: () => agents });
root.provide('systemPrompt', {
  tools: () => () => {}, section: () => () => {}, context: () => () => {}, variable: () => () => {},
  getSectionOrder: () => 0, getContextOrder: () => 0, assemble: async () => ({ sections: [] }),
});
// 0.2.1 起 dsh-tool-skill 的 inject 多了 workingDirectory（它用这个服务求 cwd），缺了它
// 宿主插件根本不会装配，探针会看到"一条目录消息都不发布"。
root.provide('workingDirectory', { ensure: async (agent) => agent?.session?.header?.cwd });
const routes = new Map();
root.provide('webServer', { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } });
root.provide('connection', { requestRejection: () => undefined });

await root.plugin(toolsModule.default, { mode: 'native' });
await root.plugin(skillPlugin.default);
const presetKey = { name: 'preset-test' };
const presetScope = scope.createScope(root, presetKey);
await presetScope.ctx.plugin(fsPlugin, { dshHome, agentsHome: dshHome, includeDefaultRoots: true, customSkillDirs: [customDir], watch: false });
const agentScope = scope.createScope(root, agent, { parent: presetKey });
agent.ctx = agentScope.ctx;

await root.plugin(plugin);
await root.plugin(skillToolPlugin);

async function callRpc(method, args = {}) {
  const route = routes.get('/api/workspace-scope/rpc');
  const req = Readable.from([Buffer.from(JSON.stringify({ method, args }))]);
  req.method = 'POST';
  req.url = '/api/workspace-scope/rpc';
  req.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json' };
  const captured = {};
  const res = { writeHead: (status) => { captured.status = status; }, end: (text) => { captured.body = text; } };
  await route.handler(req, res);
  return JSON.parse(captured.body);
}

/** 复刻 dsh-agent-loop 的一次 pre-step：claims 是这一步 claimed 的消息。 */
async function preStep(claims, step) {
  const decision = await agent.ctx.waterfall(
    'agent/pre-step',
    { agent, messages: claims, turn: 1, step, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: claims }),
  );
  // 循环随后把 decision.messages 逐条 append 到 session（surfaceOp: append）。
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' });
  return decision.messages.filter((message) => message.source?.kind === 'skill-catalog');
}

function catalogEntriesOf(message) {
  return message.source.entries;
}

const userMessage = () => llm.createUserMessage({ content: [{ type: 'text', text: '帮我看下这个技能' }], source: { kind: 'user' } });

console.log('── step 1（首次） ──');
const first = await preStep([userMessage()], 1);
assert.equal(first.length, 1, '首次应发布一条目录消息');
console.log('发布形态：', first[0].source.update === true ? 'update' : 'initial', '| 条目数:', catalogEntriesOf(first[0]).length);
console.log('目录消息字符数：', first[0].content[0].text.length);

console.log('\n── step 2（无变化） ──');
const second = await preStep([], 2);
assert.equal(second.length, 0, '目录未变时不应产生新消息');
console.log('发布条数：', second.length, '（静默）');

console.log('\n── 面板改配置：beta-skill → off ──');
const applied = await callRpc('setSkill', { cwd: projectDir, name: 'beta-skill', state: 'off' });
console.log('RPC 返回：', JSON.stringify(applied.value ?? applied));

console.log('\n── step 3（目录已变） ──');
const third = await preStep([], 3);
assert.equal(third.length, 1, '目录变化后应发布一条');
const update = third[0];
console.log('发布形态：', update.source.update === true ? 'update' : 'initial', '| 条目数:', catalogEntriesOf(update).length);
console.log('目录消息字符数：', update.content[0].text.length);
console.log('是否全量：', catalogEntriesOf(update).length >= 1 && catalogEntriesOf(update).every((entry) => typeof entry.name === 'string' && typeof entry.description === 'string'));

console.log('\n更新消息开头：\n' + update.content[0].text.split('\n').slice(0, 8).join('\n'));
console.log('\n更新消息结尾：\n' + update.content[0].text.split('\n').slice(-4).join('\n'));
const catalogEvents = session.events.filter((event) => event.data?.source?.kind === 'skill-catalog');
console.log('\n会话里的目录消息总数：', catalogEvents.length, '（1 首次 + 1 更新 = 追加，不是就地替换）');
console.log('消息序列：', session.events.map((event) => `${event.data?.source?.kind ?? event.data?.role ?? '?'}`).join(' → '));

console.log('\n── 再来一次：alpha-skill → manual ──');
await callRpc('setSkill', { cwd: projectDir, name: 'alpha-skill', state: 'manual' });
const fourth = await preStep([], 4);
const total = session.events.filter((event) => event.data?.source?.kind === 'skill-catalog').length;
console.log('第四次发布条数：', fourth.length, '| 会话目录消息累计：', total);
console.log('累计目录字符：', session.events
  .filter((event) => event.data?.source?.kind === 'skill-catalog')
  .reduce((sum, event) => sum + event.data.content[0].text.length, 0));

console.log('\n── 横跳回来：alpha-skill → pinned（digest 回到与首次相同？） ──');
await callRpc('setSkill', { cwd: projectDir, name: 'alpha-skill', state: 'pinned' });
const fifth = await preStep([], 5);
console.log('第五次发布条数：', fifth.length, '| 会话目录消息累计：', session.events.filter((event) => event.data?.source?.kind === 'skill-catalog').length);

await root.dispose?.();
if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
await rm(base, { recursive: true, force: true });
