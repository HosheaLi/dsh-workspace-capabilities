/**
 * rpc.js 路由层的契约测试：注册重试、逐请求鉴权栅栏、协议校验。
 *
 * 这里不建真实 Cordis —— 测的是 `registerRpcSurface` 这个纯函数对载体（webServer /
 * connection）的用法，宿主契约由 `test/integration.test.js` 在真实运行时上覆盖。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createPolicyResolver } from '../lib/policy.js';
import { createRpcMethods, registerRpcSurface, RPC_PATH } from '../lib/rpc.js';

/** 载体替身：捕获注册的路由与事件监听，`register` 可被替换成抛错的实现。 */
function makeCtx({ connection, register } = {}) {
  const listeners = [];
  const routes = new Map();
  const warns = [];
  const webServer = {
    register: register ?? ((route) => {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    }),
  };
  return {
    listeners,
    routes,
    warns,
    ctx: {
      logger: { warn: (...args) => warns.push(args.join(' ')) },
      on: (event, callback) => listeners.push({ event, callback }),
      get: (name) => {
        if (name === 'webServer') return webServer;
        if (name === 'connection') return connection;
        return undefined;
      },
    },
  };
}

/** 默认 logger：不需要断言告警的用例用它。 */
const logger = { warn: () => {} };

/** 用假的 node:http req/res 驱动真实的路由处理器。 */
async function call(route, { method = 'POST', headers = {}, body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = RPC_PATH;
  req.headers = headers;
  const captured = { status: undefined, body: undefined };
  await route.handler(req, {
    writeHead: (status) => {
      captured.status = status;
    },
    end: (text) => {
      captured.body = text;
    },
  });
  return captured;
}

test('路由注册失败后仍会重试：首次抛错必须挂 internal/service 监听', () => {
  let attempts = 0;
  const routes = new Map();
  const { ctx, listeners } = makeCtx({
    register: (route) => {
      attempts += 1;
      if (attempts === 1) throw new Error('webserver: duplicate exact route');
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  });
  const dispose = registerRpcSurface({ ctx, methods: {}, logger });

  assert.equal(attempts, 1, '首次应尝试注册');
  const retry = listeners.filter((entry) => entry.event === 'internal/service');
  assert.equal(retry.length, 1, '注册失败必须留下重试机会，否则面板永久没有路由');
  retry[0].callback('webServer');
  assert.equal(attempts, 2, '载体就绪后必须重试');
  assert.ok(routes.has(RPC_PATH), '重试成功应真正挂上路由');

  dispose();
  assert.equal(routes.has(RPC_PATH), false, '卸载必须撤掉路由');
});

test('没有 Connection 时退化栅栏：非回环 Host / 跨站 Origin 一律 403', async () => {
  const { ctx, routes } = makeCtx();
  registerRpcSurface({ ctx, methods: { ping: async () => 'pong' }, logger });
  const route = routes.get(RPC_PATH);

  assert.equal((await call(route, { headers: { host: 'evil.example.com' } })).status, 403, '非回环 Host 必须拒绝');
  assert.equal((await call(route, { headers: {} })).status, 403, '缺 Host 必须拒绝');
  assert.equal(
    (await call(route, { headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' } })).status,
    403,
    '跨站 Origin 必须拒绝',
  );
  assert.equal((await call(route, { headers: { host: '[::1' } })).status, 403, 'Host 无法解析必须拒绝');
  assert.equal(
    (await call(route, { headers: { host: '127.0.0.1:19387', origin: 'http://[::1' } })).status,
    403,
    'Origin 无法解析必须拒绝',
  );

  const sameOrigin = await call(route, { headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'content-type': 'application/json' }, body: JSON.stringify({ method: 'ping' }) });
  assert.equal(sameOrigin.status, 200, '回环同源必须放行');
  assert.equal(JSON.parse(sameOrigin.body).value, 'pong');

  const noOrigin = await call(route, { headers: { host: 'localhost:19387', 'content-type': 'application/json' }, body: JSON.stringify({ method: 'ping' }) });
  assert.equal(noOrigin.status, 200, '回环无 Origin（同进程客户端）必须放行');
});

test('没有 Connection 时退化栅栏：形如回环的域名必须拒绝（DNS rebinding）', async () => {
  // 回归：回环判定曾用 `/^127\./` 前缀匹配，于是 `127.0.0.1.evil.com` / `127.0.0.1.nip.io`
  // 这类「DNS 记录由攻击者控制、却长得像 127. 开头」的域名会被当成回环放行 —— 页面从该域名
  // 加载即同源，请求却落到本机回环上，这正是 DNS rebinding。判定必须只认四段十进制 IPv4。
  const { ctx, routes } = makeCtx();
  registerRpcSurface({ ctx, methods: { ping: async () => 'pong' }, logger });
  const route = routes.get(RPC_PATH);
  const json = (host) => ({ host, origin: `http://${host}`, 'content-type': 'application/json' });
  const body = JSON.stringify({ method: 'ping' });

  for (const host of ['127.0.0.1.evil.com:19387', '127.0.0.1.nip.io:19387', '128.0.0.1:19387', '126.0.0.1:19387']) {
    const denied = await call(route, { headers: json(host), body });
    assert.equal(denied.status, 403, `${host} 不是回环字面量，必须拒绝`);
    assert.notEqual(denied.body, 'pong', `${host} 不得执行到 RPC 处理体`);
  }

  // 127/8 的合法四段字面量仍要放行，别为了堵 rebinding 把整段误杀
  for (const host of ['127.9.9.9:19387', '127.0.0.1:19387']) {
    const ok = await call(route, { headers: json(host), body });
    assert.equal(ok.status, 200, `${host} 在 127/8 内，是回环`);
    assert.equal(JSON.parse(ok.body).value, 'pong');
  }

  // WHATWG 规范化会把尾点去掉，`127.0.0.1.` 就是回环 —— 这是解析器的既定行为，不是绕过。
  const trailingDot = await call(route, { headers: json('127.0.0.1.:19387'), body });
  assert.equal(trailingDot.status, 200, '尾点被规范化成回环字面量');
});

test('有 Connection 时逐请求过栅栏，而不是注册时判断一次', async () => {
  let checks = 0;
  const connection = {
    requestRejection: ({ headers }) => {
      checks += 1;
      return headers?.['x-test-auth'] === 'ok' ? undefined : 401;
    },
  };
  const { ctx, routes } = makeCtx({ connection });
  registerRpcSurface({ ctx, methods: { ping: async () => 'pong' }, logger });
  const route = routes.get(RPC_PATH);
  const base = { host: '127.0.0.1:19387', 'content-type': 'application/json' };
  const body = JSON.stringify({ method: 'ping' });

  assert.equal((await call(route, { headers: { ...base, 'x-test-auth': 'no' }, body })).status, 401);
  assert.equal((await call(route, { headers: { ...base, 'x-test-auth': 'ok' }, body })).status, 200, '带凭据的请求必须放行');
  assert.equal(checks, 2, '每次请求都要过栅栏（注册时判断一次会漏掉首屏/后续变更）');
});

test('协议校验：方法、content-type、未知方法、请求体上限', async () => {
  const { ctx, routes } = makeCtx();
  const methods = {
    ping: async () => 'pong',
    boom: async () => {
      throw new Error('业务错误');
    },
  };
  registerRpcSurface({ ctx, methods, logger });
  const route = routes.get(RPC_PATH);
  const json = { host: '127.0.0.1:19387', 'content-type': 'application/json' };

  assert.equal((await call(route, { method: 'GET', headers: json })).status, 405);
  assert.equal((await call(route, { headers: { host: '127.0.0.1:19387', 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await call(route, { headers: json, body: JSON.stringify({ method: 'nope' }) })).status, 400);
  assert.equal((await call(route, { headers: json, body: 'x'.repeat(70 * 1024) })).status, 413);

  // 方法体抛错走的是业务错误通道（200 + ok:false），不是 HTTP 错误码。
  const boom = await call(route, { headers: json, body: JSON.stringify({ method: 'boom' }) });
  assert.equal(boom.status, 200);
  assert.equal(JSON.parse(boom.body).ok, false);
  assert.match(JSON.parse(boom.body).error, /业务错误/);
});

// ── createRpcMethods：参数校验、写盘、工作区与状态载荷 ──────────────────────

/** 建一个临时 DSH_HOME + 项目目录（有 .git）+ 散目录（无 .git）。 */
async function makeHostEnv() {
  const base = await mkdtemp(join(tmpdir(), 'wscope-rpc-'));
  const home = join(base, 'dsh-home');
  const project = join(base, 'project');
  const loose = join(base, 'loose');
  await mkdir(join(home, 'settings'), { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(loose, { recursive: true });
  /**
   * 面板工作区清单的替身。真实宿主里是 `ctx.workspaceRegistry`（dsh-workspace），插件的
   * `requireScope` 只接受这份清单 ∪ 活动会话 cwd 里的目录 —— 见 `lib/rpc.js`。
   */
  const registry = (...paths) => ({ list: () => paths.map((path, index) => ({ id: `w-${index}`, title: path, path })) });
  return { base, home, project, loose, registry };
}

/** 造一个 host ctx 替身 + 方法表。 */
function makeMethods({ home, agents = [], schemas = [], workspaceRegistry, workingDirectory, onChanged } = {}) {
  const visible = new Set(schemas.map((schema) => schema.name));
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return workspaceRegistry;
      if (name === 'workingDirectory') return workingDirectory;
      if (name === 'agents') return { list: () => agents };
      return undefined;
    },
    agents: { list: () => agents },
    tools: {
      schemas: () => schemas,
      get: (name, scope) => (scope === undefined ? undefined : (visible.has(name) ? { name } : undefined)),
    },
    skills: { list: async () => [] },
  };
  const policy = createPolicyResolver({ env: { DSH_HOME: home } });
  return { methods: createRpcMethods({ ctx, policy, notifyChanged: () => onChanged?.() }), policy, ctx };
}

/** 造一个能给出技能目录的 agent。 */
const viewAgent = (cwd, rows) => ({
  id: 'ses-a',
  session: { header: { cwd } },
  ctx: { get: (service) => (service === 'skills' ? { list: async () => rows } : undefined) },
});

const SKILL_ROW = { name: 'demo', description: '演示技能', source: 'custom', path: '/x/demo/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } };

test('createRpcMethods：cwd 必须是存在的绝对目录', async () => {
  const env = await makeHostEnv();
  try {
    const { methods } = makeMethods({ home: env.home });
    for (const bad of [undefined, '', 'relative/path', 42]) {
      await assert.rejects(() => methods.state({ cwd: bad }), /cwd 必须是非空的绝对路径/, String(bad));
    }
    await assert.rejects(() => methods.state({ cwd: join(env.base, 'missing') }), /cwd 目录不存在或不是目录/);

    // 已存在、但不在面板工作区清单里：同样必须拒绝。否则任意一个已存在的目录都会被
    // `findProjectRoot` 兜底当成项目根，本插件随即在它下面 `mkdir -p` 出 .dsh/ 并写配置。
    await assert.rejects(() => methods.state({ cwd: env.loose }), /cwd 不在工作区清单里/);
    assert.equal(existsSync(join(env.loose, '.dsh')), false, '被拒绝的 cwd 不得留下任何目录');

    const file = join(env.base, 'a-file.json');
    await writeFile(file, '{}', 'utf8');
    await assert.rejects(() => methods.state({ cwd: file }), /cwd 目录不存在或不是目录/, '文件不是目录');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：写盘层选择与 layer 校验', async () => {
  const env = await makeHostEnv();
  try {
    // homedir 也要进清单，才能走到 `targetOf` 的"项目根等于 home"那条分支。
    const { methods } = makeMethods({ home: env.home, workspaceRegistry: env.registry(env.project, env.loose, homedir()) });

    await assert.rejects(
      () => methods.setSkill({ cwd: env.project, name: 'demo', state: 'off', layer: 'nope' }),
      /layer 只能是 project 或 global/,
    );
    // 只有"项目根等于 home"时项目层才不可用：其余目录即便没有 .git，项目根也兜底为 cwd。
    await assert.rejects(
      () => methods.setSkill({ cwd: homedir(), name: 'demo', state: 'off', layer: 'project' }),
      /没有 \.git 祖先/,
    );

    const projectWrite = await methods.setSkill({ cwd: env.project, name: 'demo', state: 'off' });
    assert.equal(projectWrite.layer, 'project', '有 .git 时默认写项目层');
    assert.equal(projectWrite.path, join(env.project, '.dsh', 'skills-scope.json'));

    const looseWrite = await methods.setSkill({ cwd: env.loose, name: 'demo', state: 'off' });
    assert.equal(looseWrite.layer, 'project', '没有 .git 时项目根兜底为 cwd，仍写项目层');
    assert.equal(looseWrite.path, join(env.loose, '.dsh', 'skills-scope.json'));

    const explicit = await methods.setSkill({ cwd: env.project, name: 'demo', state: 'off', layer: 'global' });
    assert.equal(explicit.layer, 'global', '显式指定优先');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：setSkill / setDefault / setMcp 的参数校验', async () => {
  const env = await makeHostEnv();
  try {
    const { methods } = makeMethods({ home: env.home, workspaceRegistry: env.registry(env.project) });
    const cwd = env.project;

    await assert.rejects(() => methods.setSkill({ cwd, name: '', state: 'off' }), /name 必须是非空字符串/);
    await assert.rejects(() => methods.setSkill({ cwd, name: 'demo', state: 'nope' }), /state 只能是/);
    await assert.rejects(() => methods.setDefault({ cwd, state: 'default' }), /state 只能是 pinned/);
    await assert.rejects(() => methods.setMcp({ cwd, server: '', enabled: true }), /server 必须是非空字符串/);
    await assert.rejects(() => methods.setMcp({ cwd, server: 'comfy', enabled: 'yes' }), /enabled 只能是/);

    // 合法值都能落盘并回显
    const cleared = await methods.setSkill({ cwd, name: 'demo', state: 'default' });
    assert.equal(cleared.state, 'default');
    assert.deepEqual(await methods.setDefault({ cwd, state: 'manual' }), { layer: 'project', path: join(cwd, '.dsh', 'skills-scope.json'), state: 'manual' });
    const mcpOff = await methods.setMcp({ cwd, server: 'comfy', enabled: false });
    assert.equal(mcpOff.enabled, false);
    const mcpDefault = await methods.setMcp({ cwd, server: 'comfy', enabled: 'default' });
    assert.equal(mcpDefault.enabled, 'default');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：workspaces 合并注册表与会话 cwd 并去重', async () => {
  const env = await makeHostEnv();
  try {
    const workspaceRegistry = {
      list: () => [
        { id: 7, title: '工作区 A', path: '/w/a' },
        { path: 123 }, // 丢弃：path 不是字符串
        { id: 8, path: '/w/b' }, // title 缺省用 path
      ],
    };
    const agents = [
      { id: 'ses-1', session: { header: { cwd: '/w/a' } } }, // 与注册表重复
      { id: 'ses-2', session: { header: { cwd: '/sessions/deep/dir' } } },
      { id: 'ses-3' }, // 没有 cwd
    ];
    const { methods } = makeMethods({ home: env.home, agents, workspaceRegistry });
    const { workspaces } = await methods.workspaces();

    assert.deepEqual(workspaces.map((workspace) => workspace.path), ['/w/a', '/w/b', '/sessions/deep/dir']);
    assert.equal(workspaces[0].title, '工作区 A');
    assert.equal(workspaces[1].title, '/w/b');
    assert.equal(workspaces[2].title, 'dir', '会话工作区用最后一段做标题');
    assert.equal(workspaces[2].id, 'session:ses-2');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：workspaces 用会话的**当前** cwd（cd 之后初始目录不再代表它）', async () => {
  const env = await makeHostEnv();
  try {
    const sessionA = { header: { cwd: '/w/a' } };
    const sessions = new Map([[sessionA, '/w/current']]);
    const workingDirectory = { get: (session) => sessions.get(session) ?? session?.header?.cwd };
    const agents = [
      { id: 'ses-1', session: sessionA },
      { id: 'ses-2', session: { header: { cwd: '/sessions/initial' } } },
    ];
    const { methods } = makeMethods({
      home: env.home,
      agents,
      workingDirectory,
      workspaceRegistry: env.registry('/w/current'),
    });
    const { workspaces } = await methods.workspaces();

    assert.deepEqual(workspaces.map((workspace) => workspace.path), ['/w/current', '/sessions/initial'], '当前目录优先，且与注册表去重');
    assert.equal(workspaces[0].title, '/w/current');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：cd 之后用当前目录匹配 agent 视图与 MCP 探针', async () => {
  const env = await makeHostEnv();
  try {
    const schemas = [{ name: 'mcp__comfy__generate' }];
    const session = { header: { cwd: env.project } };
    const workingDirectory = { get: () => env.loose };
    const agent = {
      id: 'ses-a',
      session,
      ctx: { get: (service) => (service === 'skills' ? { list: async () => [SKILL_ROW] } : undefined) },
    };
    const { methods } = makeMethods({
      home: env.home,
      agents: [agent],
      schemas,
      workingDirectory,
      workspaceRegistry: env.registry(env.project, env.loose),
    });

    const current = await methods.state({ cwd: env.loose });
    assert.equal(current.catalog.via, 'agent', '当前目录匹配的 agent 视图必须被采用');
    assert.equal(current.mcpProbe?.agentId, 'ses-a', 'MCP 探针按当前目录找同工作区 agent');
    assert.equal(current.mcp[0].visibleTools, 1);

    const initial = await methods.state({ cwd: env.project });
    assert.equal(initial.mcpProbe, undefined, '初始目录已经没有 live agent，不得拿别处的 agent 顶替');
    assert.notEqual(initial.catalog.via, 'agent');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：子目录 cd 后仍按项目根匹配 agent 与 MCP 探针，且子目录不单列成工作区', async () => {
  const env = await makeHostEnv();
  try {
    const sub = join(env.project, 'src');
    await mkdir(sub, { recursive: true });
    const schemas = [{ name: 'mcp__comfy__generate' }];
    const agent = {
      id: 'ses-a',
      session: { header: { cwd: env.project } },
      ctx: { get: (service) => (service === 'skills' ? { list: async () => [SKILL_ROW] } : undefined) },
    };
    const { methods } = makeMethods({
      home: env.home,
      agents: [agent],
      schemas,
      // 会话已经 cd 到项目子目录：原始 cwd 变了，作用域（项目根）没变。
      workingDirectory: { get: () => sub },
      workspaceRegistry: env.registry(env.project),
    });

    const { workspaces } = await methods.workspaces();
    assert.deepEqual(workspaces.map((workspace) => workspace.path), [env.project], '子目录不是独立工作区');

    const state = await methods.state({ cwd: env.project });
    assert.equal(state.catalog.via, 'agent', '同项目根的会话视图必须被采用');
    assert.equal(state.mcpProbe?.agentId, 'ses-a');
    assert.equal(state.mcp[0].visibleTools, 1);

    // 面板不再列出子目录，它也就不能作为独立作用域被请求。
    await assert.rejects(() => methods.state({ cwd: sub }), /cwd 不在工作区清单里/);
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：cd 进入的目录只可查看、不可写盘（不扩大插件写入面）', async () => {
  const env = await makeHostEnv();
  try {
    const agent = viewAgent(env.loose, [SKILL_ROW]);
    // 初始目录是 project（用户建的会话），当前目录被 cd 到 loose（模型可驱动）。
    agent.session = { header: { cwd: env.project } };
    const { methods } = makeMethods({
      home: env.home,
      agents: [agent],
      workingDirectory: { get: () => env.loose },
      workspaceRegistry: env.registry(env.project),
    });

    // 读：cd 到的目录可以看（面板要能展示它）。
    const state = await methods.state({ cwd: env.loose });
    assert.equal(state.mcpProbe?.agentId, 'ses-a', '同项目根仍然匹配会话');

    // 写：cd 只改变查看与生效策略，不扩大写入面。
    await assert.rejects(
      () => methods.setSkill({ cwd: env.loose, name: 'demo', state: 'manual' }),
      /cwd 不在可写的工作区清单里/,
    );
    assert.equal(existsSync(join(env.loose, '.dsh')), false, '被拒绝的目录不得留下任何目录');
    // 用户声明的工作区照常可写。
    const written = await methods.setDefault({ cwd: env.project, state: 'manual' });
    assert.equal(written.layer, 'project');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：state 汇总技能与 MCP，并只在同工作区有 agent 时报可见数', async () => {
  const env = await makeHostEnv();
  try {
    const schemas = [{ name: 'mcp__comfy__generate' }, { name: 'mcp__other__search' }, { name: 'bash' }];
    // 1) 有同工作区 agent：报 visibleTools
    const agent = viewAgent(env.project, [SKILL_ROW]);
    const { methods } = makeMethods({ home: env.home, agents: [agent], schemas });
    const state = await methods.state({ cwd: env.project });

    assert.equal(state.scope.cwd, env.project);
    assert.equal(state.scope.projectLayer, true);
    assert.equal(state.catalog.via, 'agent');
    assert.deepEqual(state.skills.map((row) => row.name), ['demo']);
    assert.equal(state.skills[0].state, 'pinned');
    assert.equal(state.skills[0].matchedKey, undefined, '没有显式配置时不算命中');
    assert.equal(state.skills[0].manageable, true);
    assert.deepEqual(state.totals, { total: 1, hidden: 0, off: 0, unmanageable: 0 });
    assert.deepEqual(state.mcp.map((server) => server.name), ['comfy', 'other']);
    assert.equal(state.mcp.find((server) => server.name === 'comfy').toolCount, 1);
    assert.equal(state.mcp.find((server) => server.name === 'comfy').enabled, true, '默认启用');
    assert.equal(state.mcp.find((server) => server.name === 'comfy').explicit, false);
    assert.equal(state.mcpProbe.agentId, 'ses-a');
    assert.equal(state.mcp.every((server) => server.visibleTools === server.toolCount), true);

    // 2) 没有该工作区的 agent：不报可见数，也不退回别的 agent
    const strayMethods = makeMethods({ home: env.home, agents: [], schemas, workspaceRegistry: env.registry(env.project) }).methods;
    const stray = await strayMethods.state({ cwd: env.project });
    assert.equal(stray.mcpProbe, undefined);
    assert.equal(stray.mcp.every((server) => server.visibleTools === undefined), true);
    assert.equal(stray.skills.length, 0);
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('registerRpcSurface：处理体抛错只告警，撤销时失败也只告警', async () => {
  const { ctx, routes, warns } = makeCtx();
  registerRpcSurface({ ctx, methods: { ping: async () => 'pong' }, logger: ctx.logger });
  const route = routes.get(RPC_PATH);

  // res.writeHead 抛错（响应已开始/载体异常）→ 内层兜底，不得逃逸成 unhandled rejection
  const req = Readable.from([Buffer.from('{"method":"ping"}')]);
  req.method = 'POST';
  req.url = RPC_PATH;
  req.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json' };
  await route.handler(req, { writeHead: () => { throw new Error('writeHead 爆炸'); }, end: () => {} });
  assert.match(warns.join('\n'), /面板请求处理失败/);

  // 撤销注册时载体抛错 → 同样只告警
  const { ctx: badCtx, warns: badWarns } = makeCtx({
    register: (registeredRoute) => () => { throw new Error(`remove ${registeredRoute.path} 爆炸`); },
  });
  const dispose = registerRpcSurface({ ctx: badCtx, methods: {}, logger: badCtx.logger });
  dispose();
  assert.match(badWarns.join('\n'), /撤销面板路由失败/);
});

test('createRpcMethods：totals 只把可接管技能算进隐藏/关闭', async () => {
  const env = await makeHostEnv();
  try {
    await mkdir(join(env.project, '.dsh'), { recursive: true });
    await writeFile(
      join(env.project, '.dsh', 'skills-scope.json'),
      JSON.stringify({ version: 1, skills: { 'manual-one': 'manual', 'off-one': 'off' }, mcp: {} }),
      'utf8',
    );

    const rows = [
      { name: 'manual-one', description: 'm', source: 'custom', path: '/x/m/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'off-one', description: 'o', source: 'custom', path: '/x/o/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'keep', description: 'k', source: 'custom', path: '/x/k/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      // 不可接管：正文在包内 assets，配置对它无效，不该计进"隐藏"
      { name: 'bundled-one', description: 'b', source: 'bundled', path: '/x/b/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
    ];
    const { methods } = makeMethods({ home: env.home, agents: [viewAgent(env.project, rows)] });
    const state = await methods.state({ cwd: env.project });

    assert.deepEqual(state.totals, { total: 4, hidden: 2, off: 1, unmanageable: 1 });
    const byName = new Map(state.skills.map((row) => [row.name, row]));
    assert.equal(byName.get('manual-one').state, 'manual');
    assert.equal(byName.get('manual-one').matchedKey, 'manual-one', '精确键命中');
    assert.equal(byName.get('keep').state, 'pinned');
    assert.equal(byName.get('bundled-one').manageable, false, '不可接管技能不接管');
    assert.equal(byName.get('bundled-one').size, undefined, '不可接管技能不读体积');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：state 按 可管理 → 来源 → 名称 排序，并给出目录体量与回落落点', async () => {
  const env = await makeHostEnv();
  try {
    await mkdir(join(env.project, '.dsh'), { recursive: true });
    await writeFile(
      join(env.project, '.dsh', 'skills-scope.json'),
      JSON.stringify({ version: 1, skills: { 'user-late': 'manual' }, mcp: {} }),
      'utf8',
    );
    const rows = [
      { name: 'user-late', description: '用户级', source: 'user-agents', path: '/x/u/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'proj-b', description: '项目级 B', source: 'project-dsh', path: '/x/pb/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'proj-a', description: '项目级 A', source: 'project-dsh', path: '/x/pa/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'bundle-z', description: '包内置', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'no-model', description: '不进目录', source: 'custom', path: '/x/n/SKILL.md', invocation: { modelInvocable: false, userInvocable: true } },
    ];
    const { methods } = makeMethods({ home: env.home, agents: [viewAgent(env.project, rows)] });
    const state = await methods.state({ cwd: env.project });

    assert.deepEqual(
      state.skills.map((row) => row.name),
      ['proj-a', 'proj-b', 'no-model', 'user-late', 'bundle-z'],
      '可管理组在前，组内按来源（项目 → 自定义 → 用户），不可管理组在后',
    );
    const byName = new Map(state.skills.map((row) => [row.name, row]));
    assert.equal(byName.get('proj-a').inCatalog, true);
    assert.equal(byName.get('user-late').inCatalog, false, 'manual 被摘出目录');
    assert.equal(byName.get('no-model').catalogChars, 0, 'disable-model-invocation 的技能永远不进目录');
    assert.equal(byName.get('no-model').inCatalog, false);
    assert.equal(byName.get('bundle-z').inCatalog, true, '不可管理但注册表可见 → 仍在目录里');
    assert.equal(byName.get('user-late').fallbackState, 'pinned', '删除精确键后回落到 default');
    assert.equal(byName.get('proj-a').fallbackState, undefined, '没有显式键就没有可回落的落点');
    assert.equal(byName.get('proj-a').catalogChars, '- `proj-a`: 项目级 A'.length + 1);

    const inCatalog = state.skills.filter((row) => row.inCatalog === true).map((row) => row.name);
    assert.deepEqual(inCatalog.sort(), ['bundle-z', 'proj-a', 'proj-b']);
    assert.equal(state.catalog.entries, 3);
    assert.equal(state.catalog.chars, inCatalog.reduce((sum, name) => sum + byName.get(name).catalogChars, 0));
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：setSkills 一次原子写盘、跳过不可管理/无精确键、真 no-op 不写盘', async () => {
  const env = await makeHostEnv();
  try {
    const configPath = join(env.project, '.dsh', 'skills-scope.json');
    await mkdir(join(env.project, '.dsh'), { recursive: true });
    await writeFile(configPath, JSON.stringify({ version: 1, skills: { 'glob-*': 'off', 'exact-one': 'pinned' }, mcp: {} }), 'utf8');

    const rows = [
      { name: 'exact-one', description: 'e', source: 'custom', path: '/x/e/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'glob-two', description: 'g', source: 'custom', path: '/x/g/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      // 只命中通配符、从未被显式写过：用于验证"没有可清除的显式键"
      { name: 'glob-three', description: 'g3', source: 'custom', path: '/x/g3/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'bundled-one', description: 'b', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } },
    ];
    const changes = [];
    const { methods } = makeMethods({ home: env.home, agents: [viewAgent(env.project, rows)], onChanged: () => changes.push(1) });

    // 一次调用：2 个可管理 + 1 个不可管理 + 1 个不存在 + 1 个重复名
    const result = await methods.setSkills({ cwd: env.project, names: ['exact-one', 'glob-two', 'bundled-one', 'ghost', 'exact-one'], state: 'manual' });
    assert.deepEqual(result.applied, ['exact-one', 'glob-two'], '重复名去重、不可管理与不存在都跳过');
    assert.equal(result.noop, false);
    assert.equal(result.layer, 'project');
    assert.deepEqual(result.skipped.map((item) => item.name), ['bundled-one', 'ghost']);
    assert.match(result.skipped[0].reason, /正文不在磁盘上/);
    assert.match(result.skipped[1].reason, /没有这个技能/);
    assert.equal(changes.length, 1, '一次批量只推一次缓存代际');
    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')).skills,
      { 'glob-*': 'off', 'exact-one': 'manual', 'glob-two': 'manual' },
      '两个键必须在同一次读-改-写里落盘',
    );

    // 已经是目标值：真 no-op，既不返回 path 也不碰文件
    const before = await readFile(configPath, 'utf8');
    const again = await methods.setSkills({ cwd: env.project, names: ['exact-one', 'glob-two'], state: 'manual' });
    assert.equal(again.noop, true);
    assert.equal(again.path, undefined, 'no-op 不该报写盘路径');
    assert.deepEqual(again.applied, []);
    assert.equal(changes.length, 1, 'no-op 不该推缓存代际');
    assert.equal(await readFile(configPath, 'utf8'), before);

    // default：只删精确键；通配符命中的行没有可删的键
    const cleared = await methods.setSkills({ cwd: env.project, names: ['exact-one', 'glob-three'], state: 'default' });
    assert.deepEqual(cleared.applied, ['exact-one']);
    assert.deepEqual(cleared.skipped.map((item) => item.name), ['glob-three']);
    assert.match(cleared.skipped[0].reason, /通配符/);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).skills, { 'glob-*': 'off', 'glob-two': 'manual' });
    assert.equal(changes.length, 2);

    // 参数校验：形状、条数上限、state、layer
    await assert.rejects(() => methods.setSkills({ cwd: env.project, names: undefined, state: 'off' }), /names 必须是数组/);
    await assert.rejects(() => methods.setSkills({ cwd: env.project, names: [], state: 'off' }), /names 不能为空/);
    await assert.rejects(() => methods.setSkills({ cwd: env.project, names: [42], state: 'off' }), /非空字符串/);
    await assert.rejects(
      () => methods.setSkills({ cwd: env.project, names: Array.from({ length: 201 }, (_, index) => `s${index}`), state: 'off' }),
      /一次最多 200 项/,
    );
    await assert.rejects(() => methods.setSkills({ cwd: env.project, names: ['exact-one'], state: 'nope' }), /state 只能是/);
    await assert.rejects(() => methods.setSkills({ cwd: env.project, names: ['exact-one'], state: 'off', layer: 'nope' }), /layer 只能是/);
    assert.equal(changes.length, 2, '被拒绝的调用不该写盘');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：精确键在另一层时不做"假成功"的清除', async () => {
  const env = await makeHostEnv();
  const projectConfig = join(env.project, '.dsh', 'skills-scope.json');
  try {
    // 全局层有 demo=off；项目层（有 .git）连配置文件都还没有
    await writeFile(join(env.home, 'settings', 'skills-scope.json'), JSON.stringify({ version: 1, skills: { demo: 'off' }, mcp: {} }), 'utf8');
    const rows = [{ name: 'demo', description: 'd', source: 'custom', path: '/x/demo/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } }];
    const { methods } = makeMethods({ home: env.home, agents: [viewAgent(env.project, rows)] });

    const before = await methods.state({ cwd: env.project });
    assert.equal(before.skills[0].state, 'off', '生效态来自全局层');
    assert.equal(before.skills[0].matchedKey, 'demo', '命中的是精确键');
    assert.equal(before.skills[0].fallbackState, undefined, '键不在写入层（项目层）→ 面板不该给"删除显式配置"');

    // 单条清除：不写盘、不新建项目层配置文件
    const cleared = await methods.setSkill({ cwd: env.project, name: 'demo', state: 'default' });
    assert.equal(cleared.noop, true, '跨层清除必须报 noop，而不是假装删掉了');
    assert.equal(cleared.path, undefined);
    await assert.rejects(() => readFile(projectConfig, 'utf8'), /ENOENT/, '绝不能凭空建出空的项目层配置');

    // 批量清除：跳过并给出可读原因
    const batch = await methods.setSkills({ cwd: env.project, names: ['demo'], state: 'default' });
    assert.equal(batch.noop, true);
    assert.deepEqual(batch.applied, []);
    assert.deepEqual(batch.skipped.map((item) => item.name), ['demo']);
    assert.match(batch.skipped[0].reason, /不在写入层/);
    await assert.rejects(() => readFile(projectConfig, 'utf8'), /ENOENT/);

    // 对照：键一旦落在项目层，清除照样生效，且回落态按两层合并算
    await methods.setSkill({ cwd: env.project, name: 'demo', state: 'manual' });
    const mixed = await methods.state({ cwd: env.project });
    assert.equal(mixed.skills[0].state, 'manual', '项目层近，赢过全局层');
    assert.equal(mixed.skills[0].fallbackState, 'off', '删掉项目层的键后回落到全局层的 off');
    const real = await methods.setSkills({ cwd: env.project, names: ['demo'], state: 'default' });
    assert.deepEqual(real.applied, ['demo']);
    assert.equal((await methods.state({ cwd: env.project })).skills[0].state, 'off', '清除后确实改变生效状态');
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});

test('createRpcMethods：并发 setSkills 不丢更新', async () => {
  const env = await makeHostEnv();
  try {
    const configPath = join(env.project, '.dsh', 'skills-scope.json');
    const rows = [
      { name: 'alpha', description: 'a', source: 'custom', path: '/x/a/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'beta', description: 'b', source: 'custom', path: '/x/b/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
    ];
    const { methods } = makeMethods({ home: env.home, agents: [viewAgent(env.project, rows)] });

    // 两次写并发发出：读-改-写整条链在 config 的按路径串行队列里，两边的键都必须留下
    await Promise.all([
      methods.setSkills({ cwd: env.project, names: ['alpha'], state: 'off' }),
      methods.setSkills({ cwd: env.project, names: ['beta'], state: 'manual' }),
    ]);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).skills, { alpha: 'off', beta: 'manual' });
  } finally {
    await rm(env.base, { recursive: true, force: true });
  }
});
