/**
 * 技能目录集成的搭台：真实 Cordis + 真实 dsh-tools / dsh-skill / dsh-skill-filesystem /
 * **dsh-tool-skill**（宿主侧 `<available_skills>` 的发布者）+ 本插件，
 * 外加一个最小 session 替身，用来观察每次 `agent/pre-step` 到底追加了什么消息。
 *
 * 为什么需要 session 替身：目录的"发布形态"（首次 vs 更新、全量 vs 差量、追加 vs 就地替换）
 * 是**宿主**在 `agent/pre-step` 里读 `agent.session.seq / surface.nodes / eventAt` 决定的，
 * 不落一条真实的会话记录就看不见。替身只实现宿主真正读过的那几个成员，其余保持最小。
 *
 * 运行时来自 App 包解出的 `app.asar/dsh`，缺它时调用方应整体 skip（见 `RUNTIME_READY`）。
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import * as plugin from '../../lib/index.js';
import { createWorkingDirectoryStub } from './working-directory.js';

/** 解包运行时目录（可用 `DSH_RUNTIME_DIR` 覆盖）。 */
export const RUNTIME = process.env.DSH_RUNTIME_DIR ?? '/tmp/dshref/runtime';

/** 解包运行时是否可用。缺它时集成用例整体 skip，而不是让 `npm test` 直接变红。 */
export const RUNTIME_READY = existsSync(join(RUNTIME, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'));

/** skip 原因（人看得懂的那一份）。 */
export const SKIP_REASON = `缺少解包运行时：${RUNTIME}（先从 app.asar 解出 dsh 到该目录，或设置 DSH_RUNTIME_DIR）`;

/**
 * 从解包运行时里按绝对路径 import（项目里没有 node_modules，绕开包 exports 更直接）。
 * @param pkg - 包名（如 `@deepseek-ai/dsh-tool-skill`）。
 * @param rel - 包内相对路径。
 */
export async function load(pkg, rel = 'lib/index.js') {
  const path = join(RUNTIME, 'node_modules', pkg, rel);
  if (!existsSync(path)) throw new Error(`缺少解包运行时：${path}（先设置 DSH_RUNTIME_DIR）`);
  return import(pathToFileURL(path).href);
}

/**
 * 写一个技能目录（目录形态，`<root>/<name>/SKILL.md`）。
 * @param root - 技能根。
 * @param name - 技能名。
 * @param options - `description` 会进目录条目。
 */
export async function writeSkill(root, name, { description = `${name} 的描述` } = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const frontmatter = ['---', `name: ${name}`, `description: ${description}`, '---', ''].join('\n');
  await writeFile(join(dir, 'SKILL.md'), `${frontmatter}正文\n`, 'utf8');
  return dir;
}

/**
 * 最小 session 替身：只实现宿主发布目录时真正读过的成员。
 *
 * 宿主读法（见 dsh-tool-skill 的 `catalogHistory`）：从 `seq - 1` 倒着扫 `eventAt(seq)`，
 * 只看落在 `surface.nodes` 里的那一条。`append` 的落面语义与真实 `Session.append` 对齐：
 * `surfaceOp: 'append'` 才进可见面（替换型 op 在真实宿主里按 seq range 折算，这里用不到）。
 *
 * @param cwd - 该会话的工作区目录（`agent.session.header.cwd`）。
 */
export function createSessionDouble(cwd) {
  const events = [];
  const nodes = [];
  return {
    id: 'ses-catalog-test',
    header: { cwd },
    events,
    nodes,
    get seq() {
      return events.length;
    },
    surface: { nodes },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => undefined,
    append(type, data, options = {}) {
      const seq = events.length;
      events.push({ type, data, seq });
      if (options.surfaceOp === 'append') nodes.push(seq);
      return { seq };
    },
  };
}

/**
 * 搭一套最小但真实的宿主：本地技能 provider 挂 **preset 层**、agent 挂在它下面，
 * 正是官方 `dsh-agent-preset-registry` 的分层。
 *
 * `agents` / `systemPrompt` / `webServer` / `connection` 用最小替身（不是被测对象）；
 * `connection` 复刻鉴权语义（缺 `x-test-auth` = 401），面板 RPC 才会被放行。
 *
 * @param options - `{ dshHome, customDir, projectDir, agentId }`。
 */
export async function makeCatalogHarness({ dshHome, customDir, projectDir, agentId = 'ses-a' }) {
  const [{ Context }, scope, skillPlugin, fsPlugin, toolsModule, skillToolPlugin, llm] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/dsh-scope'),
    load('@deepseek-ai/dsh-skill'),
    load('@deepseek-ai/dsh-skill-filesystem'),
    load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-tool-skill'),
    load('@deepseek-ai/dsh-llm'),
  ]);

  const root = new Context();
  const session = createSessionDouble(projectDir);
  const agent = { id: agentId, session };
  const agents = [agent];
  root.provide('agents', { list: () => agents });
  root.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    context: () => () => {},
    variable: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    assemble: async () => ({ sections: [] }),
  });
  // 宿主 0.2.1 起 `dsh-tool-skill` 的 inject 多了 workingDirectory（目录发布用它求 cwd）。
  // 缺这个服务时该插件根本不装配，目录消息一条也不会发布 —— 那不是被测插件的回归。
  // 替身与 integration harness 共用一份（`get` 供本插件求当前目录，`ensure` 供宿主求 cwd），
  // 只实现一半会让其中一条路径静默退化。
  root.provide('workingDirectory', createWorkingDirectoryStub());

  /** 面板 RPC 的替身载体：捕获 host 注册的 exact 路由（`webServer` 是真实注册点）。 */
  const routes = new Map();
  root.provide('webServer', {
    register: (route) => {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
    host: '127.0.0.1',
    port: 0,
  });
  root.provide('connection', {
    requestRejection: ({ headers }) => (headers?.['x-test-auth'] === 'ok' ? undefined : 401),
  });

  // dsh-tools / dsh-skill 是 Service 类（default 导出）；dsh-skill-filesystem 与
  // dsh-tool-skill 是普通插件对象。挂载写法不同。
  await root.plugin(toolsModule.default, { mode: 'native' });
  await root.plugin(skillPlugin.default);

  // scope key 必须是对象（dsh-scope 用 WeakMap 记父子链）。
  const presetKey = { name: 'preset-test' };
  const presetScope = scope.createScope(root, presetKey);
  await presetScope.ctx.plugin(fsPlugin, {
    dshHome,
    agentsHome: dshHome,
    includeDefaultRoots: true,
    customSkillDirs: customDir === undefined ? [] : [customDir],
    watch: false,
  });

  // agent 对象本身就是 scope key：本插件的 shadow provider 只有落在这一层才赢得了 preset 层。
  const agentScope = scope.createScope(root, agent, { parent: presetKey });
  agent.ctx = agentScope.ctx;

  await root.plugin(plugin);
  // 宿主的目录发布者：没有它，`pre-step` 里 `ctx.tools.get('skill', agent)` 就不等于它，
  // snapshot 会被短路成空目录，什么都不会发布。
  await root.plugin(skillToolPlugin);

  /** 调面板 RPC：用一个假的 node:http req/res 驱动真实的路由处理器。 */
  async function callRpc(method, args = {}) {
    const route = routes.get('/api/workspace-scope/rpc');
    if (route === undefined) throw new Error('面板 RPC 路由应已注册到 webServer');
    const req = Readable.from([Buffer.from(JSON.stringify({ method, args }))]);
    req.method = 'POST';
    req.url = '/api/workspace-scope/rpc';
    req.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json', 'x-test-auth': 'ok' };
    const captured = { status: undefined, body: undefined };
    const res = {
      writeHead(status) {
        captured.status = status;
      },
      end(text) {
        captured.body = text;
      },
    };
    await route.handler(req, res);
    if (captured.status !== 200) return { ok: false, httpStatus: captured.status, error: captured.body };
    return JSON.parse(captured.body);
  }

  /**
   * 复刻 `dsh-agent-loop` 的一次模型步：先跑 `agent/pre-step` waterfall，再把
   * `decision.messages` **逐条追加**进会话（与 dsh-agent-loop/lib/index.js:1061 的
   * `session.append('user/message', message, { surfaceOp: 'append' })` 一致）。
   *
   * @param options - `{ claims, turn, step }`；`claims` 是这一步 claimed 的消息。
   * @returns `{ decision, appended, published }`，`published` 只含技能目录消息。
   */
  async function preStep({ claims = [], turn = 1, step = 1 } = {}) {
    const signal = new AbortController().signal;
    const decision = await agent.ctx.waterfall(
      'agent/pre-step',
      { agent, messages: claims, turn, step, signal },
      async () => ({ kind: 'enter', messages: claims }),
    );
    const appended = [];
    for (const message of decision.messages ?? []) {
      session.append('user/message', message, { surfaceOp: 'append' });
      appended.push(message);
    }
    return {
      decision,
      appended,
      published: appended.filter((message) => message.source?.kind === 'skill-catalog'),
    };
  }

  /** 会话里所有技能目录消息事件（追加型，按 seq 升序）。 */
  const catalogEvents = () => session.events.filter((event) => event.data?.source?.kind === 'skill-catalog');

  return {
    root,
    agent,
    session,
    callRpc,
    preStep,
    catalogEvents,
    /** 目录消息的正文列表（用来断言模型实际看到的内容）。 */
    catalogTexts: () => catalogEvents().map((event) => event.data.content[0].text),
    /** 该 agent 视角下的技能目录（供交叉核对，不是被断言的发布形态本身）。 */
    list: () => agentScope.ctx.get('skills').list({ cwd: projectDir, scope: agent }),
    userMessage: (text) => llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    async dispose() {
      await root.dispose?.();
    },
  };
}
