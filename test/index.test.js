/**
 * index.js 的接线测试：agent 生命周期、tools/change 补偿、面板 RPC 触发的失效，
 * 以及各条"不该拖垮插件"的 catch 分支。
 *
 * 用 stub ctx + stub agent 驱动，不需要宿主运行时；MCP 屏蔽用 scoped tools 替身观察。
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { apply, inject, name } from '../lib/index.js';

/** 轮询等待条件成立（异步补偿是 microtask 级的）。 */
async function waitFor(predicate, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate() === true) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * 造一个 agent：`ctx.get('skills')` 给注册表替身，`ctx.get('tools')` 给 scoped restrict 替身。
 * @param options - `{ id, cwd, registerProvider, invalidate, dispose }`。
 */
function makeAgent(id, cwd, options = {}) {
  const record = { restricts: [], bound: 0 };
  /** 当前生效的 deny 名单（disposer 会清空，便于观察"撤销"而不是只看到调用序列）。 */
  let activeDeny = [];
  record.currentDeny = () => activeDeny;
  const skills = {
    list: async () => [],
    registerProvider: options.registerProvider ?? ((callback) => {
      record.bound += 1;
      callback({ invalidate: options.invalidate ?? (() => {}) });
      return options.dispose ?? (() => {});
    }),
  };
  const tools = {
    restrict: ({ deny }) => {
      record.restricts.push([...deny]);
      activeDeny = [...deny];
      return () => {
        activeDeny = [];
      };
    },
    ...(options.schemas === undefined ? {} : { schemas: () => options.schemas }),
  };
  const agent = {
    id,
    session: options.session ?? { header: { cwd } },
    ctx: { get: (service) => (service === 'skills' ? skills : service === 'tools' ? tools : undefined) },
  };
  return { agent, record };
}

/** stub host ctx：事件、effect、服务与命令式 RPC 载体。 */
function makeCtx({ agents = [], schemas = [], workingDirectory } = {}) {
  const listeners = new Map();
  const effects = [];
  const warns = [];
  const routes = new Map();
  const ctx = {
    logger: { warn: (...args) => warns.push(args.join(' ')) },
    effect: (factory) => {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
    on: (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
    },
    get: (service) => {
      if (service === 'webServer') {
        return { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } };
      }
      // 真实 Cordis ctx 里 `get(name)` 与 `ctx.<name>` 都能拿到注入的服务；插件的
      // `listWorkspaces()` 走 `get('agents')`，面板 RPC 的 cwd 准入清单依赖它。
      if (service === 'agents') return { list: () => agents };
      if (service === 'workingDirectory') return workingDirectory;
      if (service === 'tools') return { schemas: () => schemas, get: () => undefined };
      return undefined;
    },
    agents: { list: () => agents },
    tools: { schemas: () => schemas, get: () => undefined },
  };
  return {
    ctx,
    warns,
    routes,
    effects,
    emit: (event, ...args) => (listeners.get(event) ?? []).map((callback) => callback(...args)),
    cleanup: () => {
      for (const disposer of [...effects].reverse()) if (typeof disposer === 'function') disposer();
    },
  };
}

/** 驱动一次面板 RPC（走真实路由处理器 + 回环 Host 栅栏）。 */
async function callRpc(routes, body) {
  const route = routes.get('/api/workspace-scope/rpc');
  assert.ok(route !== undefined, '面板路由应已注册');
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = '/api/workspace-scope/rpc';
  req.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json' };
  const captured = { status: undefined, body: undefined };
  await route.handler(req, {
    writeHead: (status) => { captured.status = status; },
    end: (text) => { captured.body = text; },
  });
  return { status: captured.status, ...(captured.body === undefined ? {} : JSON.parse(captured.body)) };
}

/** 建一个临时 DSH_HOME + 带 `.git` 的项目目录。 */
async function makeEnv() {
  const base = await mkdtemp(join(tmpdir(), 'wscope-index-'));
  const home = join(base, 'dsh-home');
  const project = join(base, 'project');
  await mkdir(join(home, 'settings'), { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(join(project, '.dsh'), { recursive: true });
  return { base, home, project };
}

test('apply：为已有 agent 注册 shadow provider，并按配置施加 MCP 屏蔽', async () => {
  const { base, home, project } = await makeEnv();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await writeFile(join(project, '.dsh', 'skills-scope.json'), JSON.stringify({ version: 1, default: 'pinned', skills: {}, mcp: { comfy: false } }));
    const { agent, record } = makeAgent('agent-1', project);
    const schemas = [{ name: 'mcp__comfy__generate' }, { name: 'mcp__other__search' }, { name: 'bash' }];
    const { ctx, routes } = makeCtx({ agents: [agent], schemas });

    apply(ctx);
    assert.equal(name, 'workspace-scope');
    assert.deepEqual(inject, ['skills', 'tools', 'agents']);
    assert.ok(routes.has('/api/workspace-scope/rpc'), '面板路由应已注册');

    assert.ok(await waitFor(() => record.restricts.length > 0), '应按工作区施加 MCP 屏蔽');
    assert.deepEqual(record.restricts.at(-1), ['mcp__comfy__generate'], '只 deny 被关服务器的工具');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
});

test('agent/created 与 agent/disposed：绑定新 agent、销毁时清账', async () => {
  const { base, home, project } = await makeEnv();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const agents = [];
    const { ctx, emit } = makeCtx({ agents });
    apply(ctx);

    const { agent, record } = makeAgent('agent-new', project);
    emit('agent/created', { agent });
    assert.equal(record.bound, 1, '新建 agent 必须绑定 shadow provider');

    emit('tools/change');
    assert.equal(record.bound, 1, 'tools/change 不该重复绑定');

    // 真实宿主在 agent 销毁后不再 list 出它；先移除再发事件，模拟这条顺序。
    agents.length = 0;
    emit('agent/disposed', { agent });
    emit('tools/change');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(record.bound, 1, 'agent 销毁后不该再被绑定');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
});

test('agent/created：必须等 MCP 限制落地才放行（子 agent 首个模型步不抢跑）', async () => {
  const { base, home, project } = await makeEnv();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await writeFile(
      join(project, '.dsh', 'skills-scope.json'),
      JSON.stringify({ version: 1, default: 'pinned', skills: {}, mcp: { comfy: false } }),
    );
    const { agent, record } = makeAgent('agent-child', project);
    const { ctx, emit } = makeCtx({ agents: [agent], schemas: [{ name: 'mcp__comfy__generate' }, { name: 'bash' }] });
    apply(ctx);

    // `agent/created` 走 ctx.serial：宿主会 await 监听器返回的 Promise，
    // 子 agent 的创建也等它结束。监听器若 fire-and-forget，Promise 立刻完成，
    // 子 agent 的第一个 tools.resolve 会拿到尚未 deny 的 MCP 工具面。
    const [pending] = emit('agent/created', { agent });
    assert.equal(typeof pending?.then, 'function', 'agent/created 监听器必须是可等待的');
    await pending;
    assert.deepEqual(record.currentDeny(), ['mcp__comfy__generate'], '放行前 deny 必须已经生效');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
});

test('apply：工具表优先从 agent 作用域的 tools 服务读（HMR 重载不依赖插件 ctx 状态）', async () => {
  const { base, home, project } = await makeEnv();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await writeFile(
      join(project, '.dsh', 'skills-scope.json'),
      JSON.stringify({ version: 1, default: 'pinned', skills: {}, mcp: { comfy: false } }),
    );
    // 宿主 ctx 的 schemas 故意给空表：真实 HMR 窗口里插件 ctx 可能尚未 active，
    // 直接访问 `ctx.tools` 会抛错；插件应改用应用器已经取到的 scoped tools。
    const { agent, record } = makeAgent('agent-child', project, { schemas: [{ name: 'mcp__comfy__generate' }] });
    const { ctx, emit } = makeCtx({ agents: [agent], schemas: [] });
    apply(ctx);

    const [pending] = emit('agent/created', { agent });
    await pending;
    assert.deepEqual(record.currentDeny(), ['mcp__comfy__generate'], '应使用 agent 作用域的 schemas 计算 deny');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
});

test('面板 RPC 写盘后：目录缓存失效 + MCP 重算；provider/dispose 失败只告警不抛', async () => {
  const { base, home, project } = await makeEnv();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const invalidations = [];
    const disposed = [];
    const { agent } = makeAgent('agent-1', project, {
      invalidate: () => invalidations.push('invalidate'),
      dispose: () => disposed.push('dispose'),
    });
    const { ctx, routes, warns, cleanup } = makeCtx({ agents: [agent] });
    apply(ctx);

    const written = await callRpc(routes, { method: 'setSkill', args: { cwd: project, name: 'x', state: 'off' } });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.deepEqual(invalidations, ['invalidate'], '写盘后必须让该 agent 的目录缓存失效');

    // 卸载：provider dispose 被调用一次；cleanup 里再抛错也只告警。
    cleanup();
    assert.deepEqual(disposed, ['dispose']);

    // 注册失败：只告警，不让插件激活失败
    const { agent: badAgent } = makeAgent('agent-bad', project, {
      registerProvider: () => { throw new Error('同层同名 provider 已注册'); },
    });
    const second = makeCtx({ agents: [badAgent] });
    apply(second.ctx);
    assert.match(second.warns.join('\n'), /注册 shadow provider 失败/, '注册失败必须留下 warn');

    // 卸载失败：dispose 抛错也要被吞掉并告警
    const { agent: throwingDisposeAgent } = makeAgent('agent-dispose-boom', project, {
      dispose: () => { throw new Error('dispose 爆炸'); },
    });
    const third = makeCtx({ agents: [throwingDisposeAgent] });
    apply(third.ctx);
    third.cleanup();
    assert.match(third.warns.join('\n'), /卸载 shadow provider 失败/, '卸载失败必须留下 warn');

    // invalidate 抛错也要被吞掉（写盘仍然成功）
    const { agent: throwingAgent } = makeAgent('agent-throw', project, { invalidate: () => { throw new Error('invalidate 爆炸'); } });
    const fourth = makeCtx({ agents: [throwingAgent] });
    apply(fourth.ctx);
    const ok = await callRpc(fourth.routes, { method: 'setSkill', args: { cwd: project, name: 'y', state: 'off' } });
    assert.equal(ok.ok, true, 'invalidate 抛错不得让写盘失败');
    assert.match(fourth.warns.join('\n'), /目录缓存失效失败/);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
});

test('会话内 cd：连续切换时在途 apply 不得用旧目录的结果覆盖最终目录', async () => {
  const { base, home, project } = await makeEnv();
  const other = join(base, 'other');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await mkdir(join(other, '.git'), { recursive: true });
    await writeFile(
      join(project, '.dsh', 'skills-scope.json'),
      JSON.stringify({ version: 1, default: 'pinned', skills: {}, mcp: { comfy: false } }),
    );

    const session = { header: { cwd: project } };
    let current = project;
    const { agent, record } = makeAgent('agent-1', project, { session });
    const schemas = [{ name: 'mcp__comfy__generate' }, { name: 'bash' }];
    const { ctx, emit } = makeCtx({ agents: [agent], schemas, workingDirectory: { get: () => current } });

    apply(ctx);
    assert.ok(await waitFor(() => record.currentDeny().length === 1), '初始目录应按配置 deny');

    // 同步连续切换：第一次的 apply 正在读盘（在途），第二次的调用会被 applicator 的哨兵
    // 拦下。没有代际补偿时，在途那次会按 other（comfy 启用）落地，最终 deny 变成空。
    current = other;
    emit('session/event', session, { type: 'working-directory/change', data: { cwd: other } });
    current = project;
    emit('session/event', session, { type: 'working-directory/change', data: { cwd: project } });

    assert.ok(await waitFor(() => record.currentDeny().length === 1), '最终结果必须按最后一次切换的目录重算');
    assert.deepEqual(record.currentDeny(), ['mcp__comfy__generate']);
    // 再等一会，确认没有滞后的在途结果把它改回去。
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(record.currentDeny(), ['mcp__comfy__generate'], '滞后落地的旧结果不得覆盖新结果');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
});

test('会话内 cd：working-directory/change 后按新目录重算 MCP 屏蔽', async () => {
  const { base, home, project } = await makeEnv();
  const other = join(base, 'other');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await mkdir(join(other, '.git'), { recursive: true });
    await writeFile(
      join(project, '.dsh', 'skills-scope.json'),
      JSON.stringify({ version: 1, default: 'pinned', skills: {}, mcp: { comfy: false } }),
    );

    const session = { header: { cwd: project } };
    let current = project;
    const workingDirectory = { get: () => current };
    const { agent, record } = makeAgent('agent-1', project, { session });
    const schemas = [{ name: 'mcp__comfy__generate' }, { name: 'bash' }];
    const { ctx, emit } = makeCtx({ agents: [agent], schemas, workingDirectory });

    apply(ctx);
    assert.ok(await waitFor(() => record.currentDeny().length > 0), '初始目录应按配置 deny');
    assert.deepEqual(record.currentDeny(), ['mcp__comfy__generate']);

    // 切换前先确认无关事件不触发重算。
    const before = record.restricts.length;
    emit('session/event', session, { type: 'user/message' });
    emit('session/event', session); // event 缺失也不能抛
    emit('session/event', { header: {} }, { type: 'working-directory/change' }); // 不属于任何 agent
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(record.restricts.length, before, '非目录切换事件 / 无主会话不得重算');

    // 切到没有配置的 other：comfy 默认启用，旧 deny 必须撤销。
    current = other;
    emit('session/event', session, { type: 'working-directory/change', data: { cwd: other } });
    assert.ok(await waitFor(() => record.currentDeny().length === 0), '切到启用 comfy 的工作区后必须撤销 deny');

    // 切回来：重新按 project 的配置 deny。
    current = project;
    emit('session/event', session, { type: 'working-directory/change', data: { cwd: project } });
    assert.ok(await waitFor(() => record.currentDeny().length === 1), '切回原目录必须重新 deny');
    assert.deepEqual(record.currentDeny(), ['mcp__comfy__generate']);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
});
