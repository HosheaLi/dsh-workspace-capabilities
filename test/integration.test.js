/**
 * 集成测试：在**真实**的 0.2.0-rc.2 运行时上验证三条机制。
 *
 * 运行前需要一份从 App 包解出来的运行时（`app.asar/dsh`）：
 *   DSH_RUNTIME_DIR=/tmp/dshref/runtime npm test
 *
 * 复刻的关键分层事实：本地技能 provider 挂在 **preset 层**，agent 挂在它下面
 * （`chainLayers(agent) = [presetLayer, agentLayer]`）。测试用
 * `createScope(..., { parent })` 原样搭出这条链 —— 这也正是"注册在 host 全局层会被
 * 静默盖掉"的验证条件。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import * as plugin from '../lib/index.js';

const RUNTIME = process.env.DSH_RUNTIME_DIR ?? '/tmp/dshref/runtime';

/** 从解包运行时里按绝对路径 import（项目里没有 node_modules，绕开包 exports 更直接）。 */
async function load(pkg, rel = 'lib/index.js') {
  const path = join(RUNTIME, 'node_modules', pkg, rel);
  if (!existsSync(path)) throw new Error(`缺少解包运行时：${path}（先设置 DSH_RUNTIME_DIR）`);
  return import(pathToFileURL(path).href);
}

/** 写一个技能目录（目录形态，`<root>/<name>/SKILL.md`）。 */
async function writeSkill(root, name, { description = `${name} 的描述`, body = '正文' } = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const frontmatter = ['---', `name: ${name}`, `description: ${description}`, '---', ''].join('\n');
  await writeFile(join(dir, 'SKILL.md'), `${frontmatter}${body}\n`, 'utf8');
  return dir;
}

/** 写一份配置 JSON。 */
async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
}

/** 读一份配置 JSON。 */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * 轮询等待条件成立。
 *
 * MCP 工具的 deny 补偿是异步的（注册 → tools/change → apply），固定 sleep 会偶发失败；
 * 这里等到条件成立或超时，失败信息留给调用方断言。
 */
async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate() === true) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * 搭一套最小但真实的宿主。
 *
 * 组成：真实 Cordis + 真实 `dsh-tools`（ToolRuntime）+ 真实 `dsh-skill` 注册表 +
 * 真实 `dsh-skill-filesystem`（挂在 preset 层）+ 每个 agent 一个 scoped context。
 * `agents` / `systemPrompt` / `connection` 用最小替身（它们不是本插件的被测对象）。
 *
 * @param options - `{ dshHome, customDir, projects }`；`projects` 是
 *   `[{ id, dir, config }]`，第一个作为主 agent。
 */
async function makeHarness({ dshHome, customDir, projects }) {
  const [{ Context }, scope, skillPlugin, fsPlugin, toolsModule] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/dsh-scope'),
    load('@deepseek-ai/dsh-skill'),
    load('@deepseek-ai/dsh-skill-filesystem'),
    load('@deepseek-ai/dsh-tools'),
  ]);

  const root = new Context();
  const agents = [];
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
  /**
   * Connection 的鉴权替身：真实实现会做 Host/Origin 栅栏 + 浏览器会话校验。
   * 这里复刻它的语义（缺 `x-test-auth` 头 = 没通过鉴权 → 401），用来验"面板 RPC 必须
   * 逐请求过栅栏"，而不是只在注册时判断一次。
   */
  root.provide('connection', {
    requestRejection: ({ headers }) => (headers?.['x-test-auth'] === 'ok' ? undefined : 401),
  });

  // dsh-tools / dsh-skill 都是 Service 类（default 导出），dsh-skill-filesystem 是
  // 普通插件对象（有 apply）。两者的挂载写法不同。
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

  const bound = [];
  for (const project of projects) {
    // 关键：**agent 对象本身就是 scope key**。注册表把 `options.scope` 当作用户传入的
    // scope，`scopeChainOf(agent)` 走的正是 agent 上的父子链 —— 官方
    // `dsh-agent-preset-registry` 就是这么把 agent scope 挂到 preset scope 下的。
    const agent = { id: project.id, session: { header: { cwd: project.dir } } };
    const agentScope = scope.createScope(root, agent, { parent: presetKey });
    agent.ctx = agentScope.ctx;
    agents.push(agent);
    bound.push({ agent, agentScope, project });
  }

  await root.plugin(plugin);

  /** 调面板 RPC：用一个假的 node:http req/res 驱动真实的路由处理器。 */
  async function callRpc(method, args = {}, { headers = {} } = {}) {
    const route = routes.get('/api/workspace-scope/rpc');
    assert.ok(route !== undefined, '面板 RPC 路由应已注册到 webServer');
    const body = Buffer.from(JSON.stringify({ method, args }));
    const req = Readable.from([body]);
    req.method = 'POST';
    req.url = '/api/workspace-scope/rpc';
    req.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json', 'x-test-auth': 'ok', ...headers };
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

  return {
    root,
    agents,
    bound,
    main: bound[0],
    callRpc,
    skillsOf: (index = 0) => bound[index].agentScope.ctx.get('skills'),
    list: (index = 0) => bound[index].agentScope.ctx.get('skills').list({ cwd: bound[index].project.dir, scope: bound[index].agent }),
    getSkill: (name, index = 0) => bound[index].agentScope.ctx.get('skills').get(name, { cwd: bound[index].project.dir, scope: bound[index].agent }),
    async dispose() {
      await root.dispose?.();
    },
  };
}

/** 每个用例一套临时目录：DSH_HOME、项目、自定义技能根。 */
async function withEnv(run, { projects = ['project'] } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'wscope-it-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(base, 'dsh-home');
  await mkdir(join(base, 'dsh-home', 'settings'), { recursive: true });
  await mkdir(join(base, 'dsh-home', 'skills'), { recursive: true });
  await mkdir(join(base, 'custom'), { recursive: true });
  const dirs = {};
  for (const name of projects) {
    dirs[name] = join(base, name);
    await mkdir(join(base, name, '.git'), { recursive: true });
    await mkdir(join(base, name, '.dsh', 'skills'), { recursive: true });
  }
  try {
    await run({ base, dshHome: process.env.DSH_HOME, customDir: join(base, 'custom'), dirs });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
}

test('manual：模型不可见但 /名 可加载，且正文与官方规则一致', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'user-skill', { body: '用户级正文' });
    await writeSkill(join(customDir), 'custom-skill', { body: '自定义目录正文' });
    await writeJson(join(dirs.project, '.dsh', 'skills-scope.json'), { version: 1, default: 'pinned', skills: { 'user-skill': 'manual' }, mcp: {} });

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      const rows = new Map((await harness.list()).map((skill) => [skill.name, skill]));
      assert.ok(rows.has('user-skill'), 'manual 技能仍应在目录里（供 / 菜单与面板使用）');

      const manual = rows.get('user-skill');
      assert.equal(manual.invocation.modelInvocable, false, 'manual 必须对模型不可见');
      assert.equal(manual.invocation.userInvocable, true, 'manual 必须保留 /名 手势');
      assert.equal(manual.provider, 'workspace-scope', '赢家应是本插件的 shadow provider');

      assert.equal(rows.get('custom-skill').invocation.modelInvocable, true, 'pinned 技能不该被接管');
      assert.equal(rows.get('custom-skill').provider, 'filesystem');

      const loaded = await harness.getSkill('user-skill');
      assert.equal(loaded.provider, 'workspace-scope');
      assert.equal(loaded.content, '用户级正文', '正文必须是去 frontmatter 后的 body');
    } finally {
      await harness.dispose();
    }
  });
});

test('off：两条调用路径都关掉', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'noisy-skill');
    await writeJson(join(dirs.project, '.dsh', 'skills-scope.json'), { version: 1, default: 'pinned', skills: { 'noisy-skill': 'off' }, mcp: {} });

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      const row = (await harness.list()).find((skill) => skill.name === 'noisy-skill');
      assert.equal(row.invocation.modelInvocable, false);
      assert.equal(row.invocation.userInvocable, false);
    } finally {
      await harness.dispose();
    }
  });
});

test('通配符 > default，精确名 > 通配符', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    for (const name of ['comfy-image', 'comfy-edit', 'writing-for-agents', 'other']) {
      await writeSkill(join(dshHome, 'skills'), name);
    }
    await writeJson(join(dirs.project, '.dsh', 'skills-scope.json'), {
      version: 1,
      default: 'manual',
      skills: { 'comfy-*': 'off', 'writing-for-agents': 'pinned', 'comfy-edit': 'manual' },
      mcp: {},
    });

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      const rows = new Map((await harness.list()).map((skill) => [skill.name, skill.invocation]));
      assert.equal(rows.get('writing-for-agents').modelInvocable, true, '精确名压过 default');
      assert.equal(rows.get('comfy-edit').userInvocable, true, '精确名 manual 压过通配符 off');
      assert.equal(rows.get('comfy-edit').modelInvocable, false);
      assert.equal(rows.get('comfy-image').userInvocable, false, '通配符 off 生效');
      assert.equal(rows.get('other').userInvocable, true, 'default=manual 生效');
      assert.equal(rows.get('other').modelInvocable, false);
    } finally {
      await harness.dispose();
    }
  });
});

test('能力边界：runtime / bundled 来源不被接管', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(customDir), 'custom-skill');
    await writeJson(join(dirs.project, '.dsh', 'skills-scope.json'), { version: 1, default: 'manual', skills: {}, mcp: {} });

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      // runtime 技能：source=runtime、无 path。即便 default=manual 也不该被接管，
      // 否则 /名 会静默失效。
      harness.skillsOf().register({ name: 'runtime-skill', description: '运行时注册的技能', content: '正文' });
      const rows = new Map((await harness.list()).map((skill) => [skill.name, skill]));
      assert.equal(rows.get('runtime-skill').invocation.modelInvocable, true, 'runtime 技能不在接管范围');
      assert.equal(rows.get('runtime-skill').provider, 'runtime');
      assert.equal(rows.get('custom-skill').invocation.modelInvocable, false, 'default=manual 作用到可管理的自定义目录技能');
    } finally {
      await harness.dispose();
    }
  });
});

test('两级配置互不污染：home 目录不是项目层', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'global-manual');
    await writeSkill(join(dshHome, 'skills'), 'project-manual');

    // 全局层：global-manual → manual
    await writeJson(join(dshHome, 'settings', 'skills-scope.json'), { version: 1, default: 'pinned', skills: { 'global-manual': 'manual' }, mcp: {} });
    // 项目层：把 global-manual 改回 pinned，并把 project-manual 设 manual
    await writeJson(join(dirs.project, '.dsh', 'skills-scope.json'), { version: 1, default: 'pinned', skills: { 'global-manual': 'pinned', 'project-manual': 'manual' }, mcp: {} });

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      const rows = new Map((await harness.list()).map((skill) => [skill.name, skill.invocation]));
      assert.equal(rows.get('global-manual').modelInvocable, true, '项目层应覆盖全局层');
      assert.equal(rows.get('project-manual').modelInvocable, false, '项目层独有配置生效');
    } finally {
      await harness.dispose();
    }
  });
});

test('MCP：按工作区 deny，重连（迟到注册）后仍被 deny，反复切换不卡死', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeJson(join(dirs.project, '.dsh', 'skills-scope.json'), {
      version: 1,
      default: 'pinned',
      skills: {},
      mcp: { comfy: false },
    });

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }, { id: 'ses-b', dir: dirs.other }] });
    const { defineContentToolFixture } = await load('@deepseek-ai/dsh-tools');
    const registerTool = (name) =>
      harness.root.tools.register(
        defineContentToolFixture({
          name,
          description: `${name} 测试工具`,
          parameters: {},
          execute: async () => ({ content: [{ type: 'text', text: name }] }),
        }),
      );

    try {
      const disposers = [registerTool('mcp__comfy__generate'), registerTool('mcp__other__search'), registerTool('bash')];
      const mainAgent = harness.bound[0].agent;
      // 等插件的 tools/change 补偿跑完（异步），而不是赌一个固定 sleep。
      assert.ok(await waitFor(() => harness.root.tools.get('mcp__comfy__generate', mainAgent) === undefined), '被关闭的服务器工具必须不可见');
      assert.notEqual(harness.root.tools.get('mcp__other__search', mainAgent), undefined, '其他服务器不受影响');

      // 迟到注册 = 服务器重连：补偿必须把它也 deny 掉（缺了这一步工具会静默回来）。
      disposers.push(registerTool('mcp__comfy__reconnected'));
      assert.ok(await waitFor(() => harness.root.tools.get('mcp__comfy__reconnected', mainAgent) === undefined), '重连后的工具必须仍被 deny');

      // 反复开关不卡死（restrict 同步 emit tools/change，防护不到位会栈溢出）。
      for (let i = 0; i < 5; i += 1) {
        const enabled = i % 2 === 0;
        const ok = await harness.callRpc('setMcp', { cwd: harness.bound[0].project.dir, server: 'comfy', enabled });
        assert.equal(ok.ok, true, `setMcp 第 ${i} 次应成功：${JSON.stringify(ok)}`);
        const synced = await waitFor(
          () => (harness.root.tools.get('mcp__comfy__generate', mainAgent) === undefined) === !enabled,
        );
        assert.ok(synced, `setMcp 第 ${i} 次（enabled=${enabled}）后可见性未同步`);
      }
      // 另一工作区不受影响：ses-b 的 cwd 没有配置，comfy 工具照常可见。
      assert.notEqual(harness.root.tools.get('mcp__comfy__generate', harness.bound[1].agent), undefined, '另一工作区不该被连累');
      for (const dispose of disposers) dispose();
    } finally {
      await harness.dispose();
    }
  });
}, { projects: ['project', 'other'] });

test('面板 RPC：state / setSkill 写盘即时生效，无需重启或新开会话', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'toggle-skill');

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      const before = await harness.callRpc('state', { cwd: dirs.project });
      assert.equal(before.ok, true, JSON.stringify(before));
      assert.equal(before.value.scope.projectLayer, true, '项目里有 .git，应启用项目层');
      assert.equal(before.value.scope.projectPath, join(dirs.project, '.dsh', 'skills-scope.json'));
      const toggleRow = before.value.skills.find((skill) => skill.name === 'toggle-skill');
      assert.equal(toggleRow.state, 'pinned');
      assert.equal(toggleRow.manageable, true);

      const written = await harness.callRpc('setSkill', { cwd: dirs.project, name: 'toggle-skill', state: 'manual' });
      assert.equal(written.ok, true, JSON.stringify(written));
      assert.equal(written.value.layer, 'project');

      // 立即生效：写盘后 notifyChanged → policy.invalidate + control.invalidate
      const after = (await harness.list()).find((skill) => skill.name === 'toggle-skill');
      assert.equal(after.invocation.modelInvocable, false, '写配置后目录必须立刻刷新（无需重启/新会话）');

      const state = await harness.callRpc('state', { cwd: dirs.project });
      assert.equal(state.value.skills.find((skill) => skill.name === 'toggle-skill').state, 'manual');

      const cleared = await harness.callRpc('setSkill', { cwd: dirs.project, name: 'toggle-skill', state: 'default' });
      assert.equal(cleared.ok, true);
      const restored = (await harness.list()).find((skill) => skill.name === 'toggle-skill');
      assert.equal(restored.invocation.modelInvocable, true, '清除显式配置后回落到 default=pinned');

      // 没有活动会话的工作区：不能拿别的 agent 顶替着报"可见性"，必须如实说没有探针。
      const stray = join(dirs.project, '..', 'stray');
      await mkdir(join(stray, '.git'), { recursive: true });
      const strayState = await harness.callRpc('state', { cwd: stray });
      assert.equal(strayState.ok, true, JSON.stringify(strayState));
      assert.equal(strayState.value.mcpProbe, undefined, '没有该工作区的 agent 就不该报可见工具数');
      assert.ok(strayState.value.mcp.every((server) => server.visibleTools === undefined));
    } finally {
      await harness.dispose();
    }
  });
});

test('面板 RPC 必须逐请求过 Connection 栅栏：无凭据返回 401，且不写盘', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'guarded-skill');
    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      // 没有 x-test-auth：替身 Connection 会返回 401。
      const denied = await harness.callRpc('state', { cwd: dirs.project }, { headers: { 'x-test-auth': '' } });
      assert.equal(denied.httpStatus, 401, '未鉴权请求必须被拦下');

      const deniedWrite = await harness.callRpc('setSkill', { cwd: dirs.project, name: 'guarded-skill', state: 'off' }, { headers: { 'x-test-auth': '' } });
      assert.equal(deniedWrite.httpStatus, 401);
      assert.equal(existsSync(join(dirs.project, '.dsh', 'skills-scope.json')), false, '被拦下的请求不得落盘');

      // 带上凭据后正常放行。
      const allowed = await harness.callRpc('setSkill', { cwd: dirs.project, name: 'guarded-skill', state: 'off' });
      assert.equal(allowed.ok, true, JSON.stringify(allowed));
      assert.equal(existsSync(join(dirs.project, '.dsh', 'skills-scope.json')), true);
    } finally {
      await harness.dispose();
    }
  });
});

test('写项目层不物化 default：全局的 manual 不会被一次技能开关顶掉', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'keep-manual');
    await writeSkill(join(dshHome, 'skills'), 'set-off');
    // 全局层：默认只手动（"别自动进模型目录"）
    await writeJson(join(dshHome, 'settings', 'skills-scope.json'), { version: 1, default: 'manual', skills: {}, mcp: {} });

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      const written = await harness.callRpc('setSkill', { cwd: dirs.project, name: 'set-off', state: 'off' });
      assert.equal(written.ok, true, JSON.stringify(written));

      const project = await readJson(join(dirs.project, '.dsh', 'skills-scope.json'));
      assert.equal('default' in project, false, '没动 default 就不该在项目层写入这个键');

      const rows = new Map((await harness.list()).map((skill) => [skill.name, skill.invocation]));
      assert.equal(rows.get('keep-manual').modelInvocable, false, '全局 default=manual 必须继续生效');
      assert.equal(rows.get('keep-manual').userInvocable, true);
      assert.equal(rows.get('set-off').userInvocable, false, '显式 off 生效');
    } finally {
      await harness.dispose();
    }
  });
});

test('两次并发写入都落盘：读-改-写在串行链内完成，不丢更新', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'first-skill');
    await writeSkill(join(dshHome, 'skills'), 'second-skill');
    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      // 两个技能几乎同时切换（两次快速点击 / 两个标签页）。
      const [first, second] = await Promise.all([
        harness.callRpc('setSkill', { cwd: dirs.project, name: 'first-skill', state: 'off' }),
        harness.callRpc('setSkill', { cwd: dirs.project, name: 'second-skill', state: 'manual' }),
      ]);
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(second.ok, true, JSON.stringify(second));

      const project = await readJson(join(dirs.project, '.dsh', 'skills-scope.json'));
      assert.deepEqual(project.skills, { 'first-skill': 'off', 'second-skill': 'manual' }, '两次改动都必须留下');
    } finally {
      await harness.dispose();
    }
  });
});

test('项目配置损坏时拒绝写入：报错而不是拿空配置覆盖用户文件', async () => {
  await withEnv(async ({ dshHome, customDir, dirs }) => {
    await writeSkill(join(dshHome, 'skills'), 'some-skill');
    const path = join(dirs.project, '.dsh', 'skills-scope.json');
    await writeFile(path, '{ 手工写坏的 json', 'utf8');

    const harness = await makeHarness({ dshHome, customDir, projects: [{ id: 'ses-a', dir: dirs.project }] });
    try {
      const written = await harness.callRpc('setSkill', { cwd: dirs.project, name: 'some-skill', state: 'off' });
      assert.equal(written.ok, false, '损坏文件必须拒写');
      assert.match(written.error, /不是合法 JSON/);
      assert.equal(await readFile(path, 'utf8'), '{ 手工写坏的 json', '原文件必须原样保留');

      // 面板仍能看到问题所在（readError），鼠标点不动但人知道去哪修。
      const state = await harness.callRpc('state', { cwd: dirs.project });
      assert.equal(state.ok, true);
      assert.match(state.value.scope.readError ?? '', /JSON 解析失败/);
    } finally {
      await harness.dispose();
    }
  });
});
