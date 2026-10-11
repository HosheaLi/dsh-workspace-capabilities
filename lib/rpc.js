/**
 * 面板 RPC：host 侧方法表 + 同源路由注册。
 *
 * 通道形状：一条 `webServer` 上的 exact 路由 `POST /api/workspace-scope/rpc`，
 * body 是 `{ method, args }`。
 *
 * **为什么不用 `connection.fetch.register`**（虽然它天然被官方 `/api` pipeline 鉴权）：
 * `webServer` 的 exact 表优先于 Connection 的 `/api` prefix 表，而 `connection` 服务的
 * 就绪时机晚于本插件 apply —— 早注册会绕开鉴权，晚注册会漏掉首屏。所以这里把两件事
 * 解耦：**注册可以早（只要有 webServer 就注册），鉴权逐请求做**，且优先复用官方
 * `connection.requestRejection`（Host/Origin 反 DNS-rebinding + 浏览器会话 cookie /
 * 进程 token），它不在时才退化为"回环 Host + 同源 Origin"的最小栅栏。
 *
 * @module dsh-workspace-scope/rpc
 */

import { stat } from 'node:fs/promises';

import { catalogCharsOf, collectCatalog, compareCatalogRows, fileSizeOf, inModelCatalog, toCatalogRow } from './catalog.js';
import {
  isState,
  matchedKeyOf,
  mergeConfig,
  skillStateOf,
  updateConfigFile,
  withDefaultState,
  withMcpEnabled,
  withSkillState,
  withoutMcpEntry,
  withoutSkillState,
} from './config.js';
import { mcpServerOf, mcpServersOf } from './mcp.js';

/** RPC 路由路径（处于 Connection 的 `/api` 前缀之下）。 */
export const RPC_PATH = '/api/workspace-scope/rpc';

/** 请求体上限：面板只传配置与查询串，64 KiB 足够。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 批量写盘一次最多接受多少个技能名：面板全选也就几十行，超出必然是脚本误用。 */
const MAX_BATCH_NAMES = 200;

/** 允许的写入层。 */
const LAYERS = new Set(['project', 'global']);

/** 一个技能允许的显式状态（`default` = 删除显式键，回落到通配符 / default）。 */
const SKILL_STATES = new Set(['pinned', 'manual', 'off', 'default']);

/**
 * 归一化批量技能名：字符串数组、元素非空、按首次出现顺序去重、有条数上限。
 *
 * 上限防的是脚本一次性传几万个名字把配置文件写爆，不是面板的正常用法（全选也就几十行）。
 * @param value - RPC 传入的 `names`。
 * @returns 去重后的技能名数组。
 * @throws 形状不合法时抛错（面板会把消息直接显示出来）。
 */
function normalizeNames(value) {
  if (!Array.isArray(value)) throw new Error('names 必须是数组');
  if (value.length === 0) throw new Error('names 不能为空');
  if (value.length > MAX_BATCH_NAMES) throw new Error(`names 一次最多 ${MAX_BATCH_NAMES} 项`);
  const names = [];
  for (const name of value) {
    if (typeof name !== 'string' || name === '') throw new Error('names 只能是非空字符串');
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** 面板的默认写盘层：有项目层就写项目层（随仓库提交），否则写全局层。与 `targetOf` 的默认分支一致。 */
function defaultLayerOf(entry) {
  return entry.scope.projectLayer === true ? 'project' : 'global';
}

/** 某个写盘层里是否有以技能名命名的**精确键**。 */
function hasExactKeyIn(entry, layer, name) {
  const config = layer === 'project' ? entry.projectRead.config : entry.globalRead.config;
  return isState(config?.skills?.[name]);
}

/**
 * 在**目标层**删掉该精确键之后的生效配置；目标层没有这个键时返回 `undefined`。
 *
 * 为什么判据必须是"目标层里有这个键"而不是合并后的生效配置：`default` 只删目标层的键。
 * 若按合并结果判断，就会出现"精确键在全局层、默认却写项目层"的**假成功** —— 回执说删了，
 * 生效状态一点没变，还凭空建出一个空的项目层配置文件。跨层键要用户改到对应层去删。
 */
function configWithoutExactKey(entry, layer, name) {
  if (!hasExactKeyIn(entry, layer, name)) return undefined;
  const target = layer === 'project' ? entry.projectRead.config : entry.globalRead.config;
  const next = withoutSkillState(target, name);
  // 近层优先：删项目层的键之后要看全局层是否还有同名键；删全局层的键时项目层（若存在）仍然优先。
  return layer === 'project' ? mergeConfig(entry.globalRead.config, next) : mergeConfig(next, entry.projectRead.config);
}

/** 删除精确键之后的生效态；目标层没有这个键时返回 `undefined`（面板据此判断能否"删除显式配置"）。 */
function fallbackStateOf(entry, layer, name) {
  const config = configWithoutExactKey(entry, layer, name);
  return config === undefined ? undefined : skillStateOf(config, name);
}

/**
 * 构造 RPC 方法表。
 *
 * @param options - 依赖。
 * @param options.ctx - host 插件上下文。
 * @param options.policy - 策略解析器（读两级配置 + 缓存失效）。
 * @param options.notifyChanged - `(cwd) => void`，配置变更后打掉技能目录缓存。
 * @returns `Record<methodName, (args) => Promise<unknown>>`。
 */
export function createRpcMethods({ ctx, policy, notifyChanged }) {
  /**
   * 校验并解析 `cwd` 参数，返回强制刷新过的策略条目。
   *
   * `cwd` 必须**真实存在**：`resolveScope` 对任何非空绝对路径都会给出 `projectRoot`
   * （`findProjectRoot` 找不到 `.git` 时兜底返回原 cwd），拿它判断存在性等于没判断 ——
   * 一个拼错或已被删除的目录会被当成合法工作区，`setSkill` 随后在虚构路径上
   * `mkdir -p` 出整条目录链并写盘。
   */
  async function requireScope(args) {
    const cwd = args?.cwd;
    if (typeof cwd !== 'string' || cwd === '' || !cwd.startsWith('/')) throw new Error('cwd 必须是非空的绝对路径');
    const info = await stat(cwd).catch(() => undefined);
    if (info === undefined || info.isDirectory() !== true) throw new Error(`cwd 目录不存在或不是目录：${cwd}`);
    return policy.read(cwd, { fresh: true });
  }

  /** 选择写盘层：显式指定优先，否则项目层可用就写项目层（随仓库提交）。 */
  function targetOf(entry, requested) {
    if (requested !== undefined) {
      if (!LAYERS.has(requested)) throw new Error(`layer 只能是 project 或 global，收到 ${JSON.stringify(requested)}`);
      if (requested === 'project' && entry.scope.projectLayer !== true) throw new Error('当前目录没有 .git 祖先，无法写项目层配置');
      return requested;
    }
    return entry.scope.projectLayer === true ? 'project' : 'global';
  }

  /** 写某一层，并让全进程的策略缓存与技能目录立刻跟上。 */
  async function writeLayer(entry, layer, mutate) {
    const projectLayer = layer === 'project';
    const path = projectLayer ? entry.scope.projectPath : entry.scope.globalPath;
    // 读-改-写整体交给 config 层的串行链：基线必须是链内的最新文件，而不是本请求开头
    // 那份快照（两次快速点击会用同一份快照互相覆盖）。
    await updateConfigFile(path, mutate);
    policy.invalidate();
    notifyChanged(entry.scope.cwd);
    return path;
  }

  /** 列出可配置的工作区：注册表 + 活动会话的 cwd。 */
  function listWorkspaces() {
    const out = new Map();
    const registry = ctx.get('workspaceRegistry');
    if (registry !== undefined && typeof registry.list === 'function') {
      for (const workspace of registry.list()) {
        if (typeof workspace?.path !== 'string') continue;
        out.set(workspace.path, { id: String(workspace.id), title: workspace.title ?? workspace.path, path: workspace.path });
      }
    }
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd !== 'string' || cwd === '' || out.has(cwd)) continue;
      const segments = cwd.split('/').filter((segment) => segment !== '');
      out.set(cwd, { id: `session:${String(agent.id)}`, title: segments.at(-1) ?? cwd, path: cwd });
    }
    return [...out.values()];
  }

  return {
    /** 列出工作区清单（面板首屏先拿它选一个 cwd，再拉 {@link state}）。 */
    async workspaces() {
      return { workspaces: listWorkspaces() };
    },

    /** 面板一次性拉全量状态：作用范围、工作区清单、技能目录（含生效状态）、MCP 服务器。 */
    async state(args) {
      const entry = await requireScope(args);
      const catalog = await collectCatalog(ctx, { cwd: entry.scope.cwd });
      // 面板不传 layer：默认写项目层（没有项目层时才是全局层），"可清除"的判据也按这一层算。
      const writeLayer = defaultLayerOf(entry);
      const rows = [];
      let hidden = 0;
      let off = 0;
      let unmanageable = 0;
      for (const skill of catalog.rows) {
        const row = toCatalogRow(skill);
        const { key, state } = matchedKeyOf(entry.effective, row.name);
        // 只有本插件接管得了的技能才谈得上"隐藏"：bundled/runtime 的正文不在磁盘上、
        // 配置对它们无效，算进隐藏数只会让面板数字虚高。
        if (row.manageable) {
          if (state !== 'pinned') hidden += 1;
          if (state === 'off') off += 1;
        } else {
          unmanageable += 1;
        }
        const enriched = {
          ...row,
          state,
          matchedKey: key,
          // 删掉精确键之后的生效态：面板用它给"删除显式配置"标注回落到哪一态，也用它估算该动作
          // 对目录体量的影响。**目标层没有这个键时为 undefined**（跨层键删了也不改变生效状态）。
          fallbackState: key === row.name ? fallbackStateOf(entry, writeLayer, row.name) : undefined,
          size: row.manageable ? await fileSizeOf(row.path) : undefined,
        };
        // 目录体量的两个字段是**估算**：真实目录由宿主渲染，这里复刻它的规则给面板看趋势。
        enriched.catalogChars = catalogCharsOf(enriched);
        enriched.inCatalog = inModelCatalog(enriched);
        rows.push(enriched);
      }
      rows.sort(compareCatalogRows);
      const catalogEntries = rows.filter((row) => row.inCatalog === true).length;
      const catalogChars = rows.reduce((sum, row) => sum + (row.inCatalog === true ? row.catalogChars : 0), 0);

      const schemas = ctx.tools?.schemas?.() ?? [];
      const explicitMcp = { ...entry.globalRead.config.mcp, ...entry.projectRead.config.mcp };
      // 用一个**同工作区**的真实 agent 视角数一遍可见工具：被关掉的服务器如果还能看到
      // 工具，就是屏蔽没生效（面板会把这行标出来），而不是静默地"看起来配置好了"。
      // 不能退而取任意 agent —— 别的 cwd 有自己的配置，数出来的可见数会张冠李戴。
      const liveAgents = ctx.get('agents')?.list?.() ?? [];
      const probeAgent = liveAgents.find((agent) => agent?.session?.header?.cwd === entry.scope.cwd);
      // 已知服务器名来自配置：工具名不可靠反解（serverName 允许含 `__`），见 mcp.js。
      const knownServers = Object.keys(explicitMcp);
      const mcp = mcpServersOf(schemas, knownServers).map((server) => {
        const owned = schemas.filter((schema) => mcpServerOf(schema?.name, knownServers) === server);
        return {
          name: server,
          toolCount: owned.length,
          enabled: entry.effective.mcp[server] !== false,
          explicit: Object.hasOwn(explicitMcp, server),
          visibleTools: probeAgent === undefined ? undefined : owned.filter((schema) => ctx.tools.get(schema.name, probeAgent) !== undefined).length,
        };
      });

      return {
        scope: {
          cwd: entry.scope.cwd,
          projectRoot: entry.scope.projectRoot,
          projectLayer: entry.scope.projectLayer,
          projectPath: entry.scope.projectPath,
          globalPath: entry.scope.globalPath,
          notice: entry.scope.notice,
          projectConfigExists: entry.projectRead.exists === true,
          globalConfigExists: entry.globalRead.exists === true,
          readError: entry.projectRead.error ?? entry.globalRead.error,
        },
        defaultState: entry.effective.default,
        workspaces: listWorkspaces(),
        catalog: {
          via: catalog.via,
          incomplete: catalog.incomplete === true,
          notice: catalog.notice,
          // 当前会进模型目录的条目数与字符数（估算，口径见 catalog.js）。
          entries: catalogEntries,
          chars: catalogChars,
        },
        skills: rows,
        mcp,
        mcpProbe: probeAgent === undefined ? undefined : { agentId: String(probeAgent.id) },
        totals: { total: rows.length, hidden, off, unmanageable },
      };
    },

    /**
     * 设置一个技能的显式状态；`state: 'default'` 表示删除该键、回落到通配符/default。
     *
     * `default` 只在**目标层确实有这个精确键**时才写盘：键在另一层时删除它不会改变生效状态，
     * 写了只会凭空建出一个空配置文件（`noop: true`）。
     */
    async setSkill(args) {
      const entry = await requireScope(args);
      const name = args?.name;
      if (typeof name !== 'string' || name === '') throw new Error('name 必须是非空字符串');
      const state = args?.state;
      if (!SKILL_STATES.has(state)) throw new Error('state 只能是 pinned / manual / off / default');
      const layer = targetOf(entry, args?.layer);
      if (state === 'default' && configWithoutExactKey(entry, layer, name) === undefined) {
        return { layer, name, state, noop: true };
      }
      const path = await writeLayer(entry, layer, (config) => (state === 'default' ? withoutSkillState(config, name) : withSkillState(config, name, state)));
      return { layer, path, name, state };
    },

    /**
     * 批量设置技能状态：N 个名字 → **一次**读-改-写、一次缓存失效。
     *
     * 为什么不是一个循环调用 {@link setSkill}：那样会写 N 次盘、推 N 次缓存代际、产生 N 个
     * 中间状态；而宿主在**每个模型步**都会重算技能目录 digest，跨越模型步的中间状态会让该
     * 会话多追加几份完整目录（见 README「改配置对进行中的会话意味着什么」）。批量把这件事
     * 收敛成一次原子写盘、一个确定的状态。
     *
     * 跳过规则（`skipped` 逐条回报给面板，不影响其余名字）：
     *  - 目录里没有这个名字（注册表此刻看不见它）；
     *  - 不可管理（bundled/runtime，或注册表没给正文 path）；
     *  - `state: 'default'` 但命中的是通配符/默认 —— 配置里没有以技能名命名的键可删；
     *  - `state: 'default'` 但精确键不在**目标层**（键在另一层，删了不改变生效状态）。
     * 另外"已经是同一个显式值"的名字会**静默略过**（不是错误，也不占 `applied`）。
     * 没有任何名字需要写盘时返回 `noop: true` 且**不碰配置文件**（避免无意义的 git diff）；
     * 此时 `skipped` 是否为空可以区分"全部已是目标值"与"全部被跳过"两种情况。
     */
    async setSkills(args) {
      const entry = await requireScope(args);
      const names = normalizeNames(args?.names);
      const state = args?.state;
      if (!SKILL_STATES.has(state)) throw new Error('state 只能是 pinned / manual / off / default');
      const layer = targetOf(entry, args?.layer);
      const catalog = await collectCatalog(ctx, { cwd: entry.scope.cwd });
      const known = new Map(catalog.rows.map((skill) => [skill.name, toCatalogRow(skill)]));
      const applied = [];
      const skipped = [];
      for (const name of names) {
        const row = known.get(name);
        if (row === undefined) {
          skipped.push({ name, reason: '当前目录里没有这个技能' });
          continue;
        }
        if (!row.manageable) {
          skipped.push({ name, reason: row.reason ?? '不可管理' });
          continue;
        }
        const matched = matchedKeyOf(entry.effective, name);
        if (state === 'default') {
          if (matched.key !== name) {
            skipped.push({ name, reason: '命中的是通配符/默认，没有可清除的显式键' });
            continue;
          }
          if (configWithoutExactKey(entry, layer, name) === undefined) {
            skipped.push({ name, reason: `显式配置不在写入层（${layer === 'project' ? '项目层' : '全局层'}），删除它不会改变生效状态` });
            continue;
          }
        } else if (matched.key === name && matched.state === state) {
          continue;
        }
        applied.push(name);
      }
      if (applied.length === 0) return { layer, applied, skipped, noop: true };
      const path = await writeLayer(entry, layer, (config) =>
        applied.reduce((next, name) => (state === 'default' ? withoutSkillState(next, name) : withSkillState(next, name, state)), config));
      return { layer, path, applied, skipped, noop: false };
    },

    /** 设置工作区默认状态。 */
    async setDefault(args) {
      const entry = await requireScope(args);
      const state = args?.state;
      if (state !== 'pinned' && state !== 'manual' && state !== 'off') throw new Error('state 只能是 pinned / manual / off');
      const layer = targetOf(entry, args?.layer);
      const path = await writeLayer(entry, layer, (config) => withDefaultState(config, state));
      return { layer, path, state };
    },

    /** 开关一个 MCP 服务器；`enabled: 'default'` 表示删除该键、回落到全局/默认。 */
    async setMcp(args) {
      const entry = await requireScope(args);
      const server = args?.server;
      if (typeof server !== 'string' || server === '') throw new Error('server 必须是非空字符串');
      const enabled = args?.enabled;
      if (enabled !== 'default' && typeof enabled !== 'boolean') throw new Error('enabled 只能是 true / false / default');
      const layer = targetOf(entry, args?.layer);
      const path = await writeLayer(entry, layer, (config) => (enabled === 'default' ? withoutMcpEntry(config, server) : withMcpEnabled(config, server, enabled === true)));
      return { layer, path, server, enabled };
    },
  };
}

/**
 * 把 RPC 挂到当前可用的 HTTP 载体上。
 *
 * @param options - 依赖。
 * @param options.ctx - host 插件上下文。
 * @param options.methods - {@link createRpcMethods} 的方法表。
 * @param options.logger - 日志器。
 * @returns `() => void`：撤销注册。
 */
export function registerRpcSurface({ ctx, methods, logger }) {
  let dispose;
  let attached = false;

  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  async function handleFetch(request) {
    if (request.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return json(415, { ok: false, error: 'content-type 必须是 application/json' });
    try {
      const text = await request.text();
      const body = text === '' ? {} : JSON.parse(text);
      const method = body?.method;
      // own-property 判定：`methods[method]` 直接下标会命中原型链，"constructor" /
      // "toString" 都会被当成 handler 调用。
      const handler = typeof method === 'string' && Object.hasOwn(methods, method) ? methods[method] : undefined;
      if (handler === undefined) return json(400, { ok: false, error: `未知方法 ${JSON.stringify(method)}` });
      return json(200, { ok: true, value: await handler(body.args ?? {}) });
    } catch (error) {
      return json(200, { ok: false, error: String(error?.message ?? error) });
    }
  }

  /** 无 Connection 时的最小栅栏：Host 必须是回环，且已附带 Origin 时须同源。 */
  function localOnly(headers) {
    const host = headers.host;
    if (typeof host !== 'string') return false;
    let authority;
    try {
      authority = new URL(`http://${host}`);
    } catch {
      return false;
    }
    const loopback = authority.hostname === 'localhost' || authority.hostname === '[::1]' || /^127\./.test(authority.hostname);
    if (!loopback) return false;
    const origin = headers.origin;
    if (typeof origin !== 'string') return true;
    try {
      return new URL(origin).host === authority.host;
    } catch {
      return false;
    }
  }

  /**
   * 请求栅栏。优先用官方 `connection.requestRejection`（Host/Origin 反 DNS-rebinding +
   * 浏览器会话 cookie / 进程 token 鉴权），它不在时就退化为"回环 Host + 同源 Origin"。
   *
   * **每条请求都要过栅栏**，而不是只在注册时判断一次：`webServer` 的 exact 表优先于
   * Connection 的 `/api` prefix 表，注册在这张表上意味着**绕开了官方那条已鉴权的
   * pipeline**；而 `connection` 服务的就绪时机又晚于本插件 apply，所以注册与鉴权必须
   * 解耦 —— 注册可以早，鉴权必须逐请求做。
   *
   * @param headers - node:http 请求头。
   * @returns 401 / 403，或 `undefined` 表示放行。
   */
  function fence(headers) {
    const connection = ctx.get('connection');
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      return connection.requestRejection({ headers });
    }
    return localOnly(headers) ? undefined : 403;
  }

  function register() {
    if (attached) return;
    const webServer = ctx.get('webServer') ?? ctx.get('httpServer');
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    // 先注册成功再置 `attached`：路由重名会抛错，若提前置位就不会再挂重试监听，
    // 面板会永久没有路由（且只剩一条 warn 说明不了问题）。
    const remove = webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        // 整个处理体必须自带兜底：路由 handler 是 async，逃出去的异常会成为
        // unhandled rejection（Node 默认直接终止进程），请求也永远拿不到响应。
        try {
          // 先过栅栏，再读 body：鉴权失败时不浪费一次 64 KiB 的读取。
          const rejection = fence(req.headers);
          if (rejection !== undefined) {
            res.writeHead(rejection);
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
          // 方法检查必须在**构造 Request 之前**：`new Request(url, { method:'GET', body })`
          // 直接抛 TypeError，一个走错的 GET（探活、预取、爬虫）就能打崩宿主进程。
          if ((req.method ?? '').toUpperCase() !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              res.writeHead(413);
              res.end();
              return;
            }
            chunks.push(chunk);
          }
          const url = new URL(req.url ?? RPC_PATH, 'http://dsh.internal');
          const headers = Object.fromEntries(Object.entries(req.headers).filter(([, value]) => typeof value === 'string'));
          const request = new Request(url, { method: 'POST', headers, body: Buffer.concat(chunks) });
          const response = await handleFetch(request);
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          res.end(await response.text());
        } catch (error) {
          logger?.warn?.(`workspace-scope: 面板请求处理失败：${String(error?.message ?? error)}`);
          try {
            res.writeHead(500);
            res.end('internal error');
          } catch {
            /* 响应已经开始，改不了状态码，只能就此结束 */
          }
        }
      },
    });
    dispose = remove;
    attached = true;
  }

  function safeRegister() {
    try {
      register();
    } catch (error) {
      logger?.warn?.(`workspace-scope: 注册面板路由失败：${String(error?.message ?? error)}`);
    }
  }

  safeRegister();
  if (!attached) {
    ctx.on('internal/service', (serviceName) => {
      if (serviceName === 'webServer' || serviceName === 'httpServer') safeRegister();
    });
  }

  return () => {
    try {
      dispose?.();
    } catch (error) {
      logger?.warn?.(`workspace-scope: 撤销面板路由失败：${String(error?.message ?? error)}`);
    }
    dispose = undefined;
    attached = false;
  };
}
