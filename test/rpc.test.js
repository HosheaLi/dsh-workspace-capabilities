/**
 * rpc.js 路由层的契约测试：注册重试、逐请求鉴权栅栏、协议校验。
 *
 * 这里不建真实 Cordis —— 测的是 `registerRpcSurface` 这个纯函数对载体（webServer /
 * connection）的用法，宿主契约由 `test/integration.test.js` 在真实运行时上覆盖。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  return { base, home, project, loose };
}

/** 造一个 host ctx 替身 + 方法表。 */
function makeMethods({ home, agents = [], schemas = [], workspaceRegistry } = {}) {
  const visible = new Set(schemas.map((schema) => schema.name));
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return workspaceRegistry;
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
  return { methods: createRpcMethods({ ctx, policy, notifyChanged: () => {} }), policy, ctx };
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
    const { methods } = makeMethods({ home: env.home });

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
    const { methods } = makeMethods({ home: env.home });
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
    const strayMethods = makeMethods({ home: env.home, agents: [], schemas }).methods;
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
