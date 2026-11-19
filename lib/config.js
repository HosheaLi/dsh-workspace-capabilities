/**
 * 两级配置的路径解析、归一化、合并、匹配与原子写入。
 *
 * 层级（项目级优先）：
 *  - 全局：`$DSH_HOME/settings/skills-scope.json`
 *  - 项目：`<项目根>/.dsh/skills-scope.json`（随仓库提交，团队共享）
 *
 * **路径必须分离**：官方 `findProjectRoot` 在找不到 `.git` 祖先时兜底返回原始
 * cwd，而 `~` 下没有 `.git`，所以在 home 目录里工作时"项目根"就是 home。若全局
 * 配置也放在 `$DSH_HOME/skills-scope.json`，两级配置会变成同一个文件而静默互相
 * 覆盖。本模块用两条防线：全局放 `settings/` 子目录；项目根等于 home 时跳过项目
 * 层（见 {@link resolveScope}）。
 *
 * 写盘一律走 {@link updateConfigFile}（链内读-改-写、保留未知顶层键、损坏文件拒写），
 * 不用"先读快照再写"—— 那条路会丢并发更新，也会用空配置覆盖用户的手工文件。
 *
 * 本模块只依赖 node 内置模块，不 import 任何 `@deepseek-ai/*`，因此不受宿主版本
 * 漂移影响。
 *
 * @module dsh-workspace-capabilities/config
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 技能的三种注入状态。 */
export const STATES = /** @type {const} */ (['pinned', 'manual', 'off']);

/** 未配置时的默认状态：完全保持 DSH 现状（进目录、可被模型调用、可 `/名`）。 */
export const DEFAULT_STATE = 'pinned';

/** 配置文件格式版本，写入时带上，便于将来迁移。 */
export const CONFIG_VERSION = 1;

/** 全局配置相对 `$DSH_HOME` 的路径。 */
export const GLOBAL_CONFIG_RELATIVE = join('settings', 'skills-scope.json');

/** 项目配置相对项目根的路径。 */
export const PROJECT_CONFIG_RELATIVE = join('.dsh', 'skills-scope.json');

/** 判断一个字符串是否是合法状态值。 */
export function isState(value) {
  return typeof value === 'string' && STATES.includes(/** @type {any} */ (value));
}

/** 解析 DSH home：优先 `$DSH_HOME`，否则 `~/.dsh`。 */
export function dshHome(env = process.env) {
  const configured = env?.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  return join(homedir(), '.dsh');
}

/**
 * 全局配置文件路径。
 * @param env - 用于解析 `$DSH_HOME` 的环境（默认 `process.env`）。
 */
export function globalConfigPath(env = process.env) {
  return join(dshHome(env), GLOBAL_CONFIG_RELATIVE);
}

/**
 * 项目配置文件路径。
 * @param projectRoot - 项目根目录绝对路径。
 */
export function projectConfigPath(projectRoot) {
  return join(projectRoot, PROJECT_CONFIG_RELATIVE);
}

/** 读取一个已存在目录的类型；不存在返回 undefined。 */
async function statKind(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/**
 * 沿用 DSH 的项目根判定：最近的含 `.git` 的祖先目录；找不到则返回原始 cwd。
 *
 * 与 `dsh-skill-filesystem` 的 `findProjectRoot` 同规则（不 import 它，避免版本耦合）。
 * @param cwd - 会话工作目录。
 * @returns 项目根绝对路径。
 */
export async function findProjectRoot(cwd) {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    if (await statKind(join(current, '.git')) !== undefined) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * 解析某个 cwd 对应的作用范围：项目根、是否启用项目层、跳过原因。
 * @param cwd - 会话工作目录（可为空字符串）。
 * @param env - 用于解析 `$DSH_HOME` 的环境。
 * @returns `{ cwd, projectRoot, projectLayer, projectPath, globalPath, notice }`。
 */
export async function resolveScope(cwd, env = process.env) {
  const home = dshHome(env);
  const projectRoot = typeof cwd === 'string' && cwd.trim() !== '' ? await findProjectRoot(cwd) : undefined;
  const isHome = projectRoot !== undefined && resolve(projectRoot) === resolve(homedir());
  const projectLayer = projectRoot !== undefined && !isHome;
  return {
    cwd: typeof cwd === 'string' ? cwd : '',
    projectRoot,
    projectLayer,
    projectPath: projectLayer ? projectConfigPath(projectRoot) : undefined,
    globalPath: globalConfigPath(env),
    notice: isHome
      ? '当前目录没有 .git 祖先，项目根等于 home：已跳过项目层，只读写全局配置'
      : undefined,
  };
}

/** 空配置文档。 */
export function emptyConfig() {
  return { version: CONFIG_VERSION, default: undefined, skills: {}, mcp: {} };
}

/** 通配符 `*`（任意长度）与 `?`（单字符）编译成正则；其余字符按字面量转义。 */
export function globToRegExp(pattern) {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

/**
 * 防御性归一化：只保留已知形状，任何多余/类型不符的字段直接丢弃。
 * @param raw - `JSON.parse` 得到的任意值。
 * @returns 归一化后的配置文档。
 */
export function normalizeConfig(raw) {
  const config = emptyConfig();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config;
  if (isState(raw.default)) config.default = raw.default;
  if (raw.skills !== null && typeof raw.skills === 'object' && !Array.isArray(raw.skills)) {
    for (const [name, state] of Object.entries(raw.skills)) {
      // 只跳过空键。技能名可以正好叫 `default`（`skills.default` 与顶层 `default` 是两个
      // 不同的键），早先把它一并跳过会让"给名为 default 的技能设状态"变成静默无效。
      if (name === '') continue;
      if (isState(state)) config.skills[name] = state;
    }
  }
  if (raw.mcp !== null && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp)) {
    for (const [server, enabled] of Object.entries(raw.mcp)) {
      if (server === '') continue;
      if (typeof enabled === 'boolean') config.mcp[server] = enabled;
    }
  }
  return config;
}

/**
 * 读一个配置文件；缺失或损坏都降级为空配置（损坏时返回 `error` 供面板提示）。
 * @param path - 配置文件绝对路径。
 * @returns `{ config, exists, error }`。
 */
export async function readConfigFile(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: emptyConfig(), exists: false };
    return { config: emptyConfig(), exists: false, error: `读取失败：${String(error?.message ?? error)}` };
  }
  try {
    return { config: normalizeConfig(JSON.parse(raw)), exists: true, raw };
  } catch (error) {
    return { config: emptyConfig(), exists: true, error: `JSON 解析失败：${String(error?.message ?? error)}` };
  }
}

/**
 * 合并两级配置：项目层逐键覆盖全局层；`default` 同理。
 * @param globalConfig - 全局层配置。
 * @param projectConfig - 项目层配置（可为 undefined）。
 * @returns 生效配置 `{ default, skills, mcp }`。
 */
export function mergeConfig(globalConfig, projectConfig) {
  const skills = { ...(globalConfig?.skills ?? {}), ...(projectConfig?.skills ?? {}) };
  const mcp = { ...(globalConfig?.mcp ?? {}), ...(projectConfig?.mcp ?? {}) };
  const fallback = projectConfig?.default ?? globalConfig?.default ?? DEFAULT_STATE;
  return { default: isState(fallback) ? fallback : DEFAULT_STATE, skills, mcp };
}

/**
 * 挑出命中 `name` 的**最长**通配符模式（长度相同按码点序取小，保证确定性）。
 *
 * `skillStateOf` 与 `matchedKeyOf` 共用它，避免"决定状态的模式"和"面板显示的模式"
 * 各算各的 —— 后者曾经返回**第一个状态值相同**的命中，于是一起生效的两个模式里
 * 面板会报出较宽的那个，与实际生效的键不符。
 * @param skills - 显式配置的技能键值表。
 * @param name - 技能名。
 * @returns 命中的模式；未命中返回 `undefined`。
 */
function bestGlobPatternOf(skills, name) {
  let best;
  for (const pattern of Object.keys(skills ?? {})) {
    if (!pattern.includes('*') && !pattern.includes('?')) continue;
    if (!globToRegExp(pattern).test(name)) continue;
    if (best === undefined || pattern.length > best.length || (pattern.length === best.length && pattern < best)) {
      best = pattern;
    }
  }
  return best;
}

/**
 * 按"精确名 > 通配符 > default"求一个技能的生效状态。
 *
 * 多个通配符命中时取**最长模式**（更具体的赢）；长度相同按码点序取小，保证确定性。
 * @param effective - {@link mergeConfig} 的结果。
 * @param name - 技能名。
 * @returns 三种状态之一。
 */
export function skillStateOf(effective, name) {
  const exact = effective?.skills?.[name];
  if (isState(exact)) return exact;
  const pattern = bestGlobPatternOf(effective?.skills, name);
  if (pattern !== undefined) return effective.skills[pattern];
  return isState(effective?.default) ? effective.default : DEFAULT_STATE;
}

/**
 * 列出配置里显式命中某技能的键（用于面板提示"这条来自通配符"）。
 * @param effective - {@link mergeConfig} 的结果。
 * @param name - 技能名。
 * @returns `{ key, state }`，精确名优先，否则命中的最长通配符。
 */
export function matchedKeyOf(effective, name) {
  if (isState(effective?.skills?.[name])) return { key: name, state: effective.skills[name] };
  const pattern = bestGlobPatternOf(effective?.skills, name);
  if (pattern !== undefined) return { key: pattern, state: effective.skills[pattern] };
  return { key: undefined, state: isState(effective?.default) ? effective.default : DEFAULT_STATE };
}

/** 不可变地设置一个技能的显式状态。 */
export function withSkillState(config, name, state) {
  return { ...config, skills: { ...config.skills, [name]: state } };
}

/** 不可变地删除一个技能的显式状态（回落到通配符 / default）。 */
export function withoutSkillState(config, name) {
  const skills = { ...config.skills };
  delete skills[name];
  return { ...config, skills };
}

/** 不可变地设置一个 MCP 服务器的启用位。 */
export function withMcpEnabled(config, server, enabled) {
  return { ...config, mcp: { ...config.mcp, [server]: enabled === true } };
}

/** 不可变地删除一个 MCP 服务器的显式启用位。 */
export function withoutMcpEntry(config, server) {
  const mcp = { ...config.mcp };
  delete mcp[server];
  return { ...config, mcp };
}

/** 不可变地设置默认状态。 */
export function withDefaultState(config, state) {
  return { ...config, default: state };
}

/** 本插件管理的顶层键；其余顶层键写盘时原样保留。 */
const MANAGED_KEYS = new Set(['version', 'default', 'skills', 'mcp']);

/**
 * 序列化用的文档形状：稳定的键序，只含本插件管理的键。
 *
 * `default` **只在被显式设过时才落盘**。若像早先那样缺省写成 `"pinned"`，就把它物化成了
 * 显式配置 —— 而项目层优先于全局层，于是"在项目里关掉一个技能"会顺带用 `pinned` 静默
 * 盖掉用户在全局设的 `manual`/`off`，让本该不进模型目录的技能重新自动注入。
 * @param config - 归一化后的配置文档。
 */
function renderDocument(config) {
  const skills = {};
  for (const name of Object.keys(config.skills ?? {}).sort()) skills[name] = config.skills[name];
  const mcp = {};
  for (const server of Object.keys(config.mcp ?? {}).sort()) mcp[server] = config.mcp[server];
  return {
    version: CONFIG_VERSION,
    ...(config.default === undefined ? {} : { default: config.default }),
    skills,
    mcp,
  };
}

/** 序列化：稳定的键序 + 2 空格缩进 + 末尾换行，让 diff 可读、可提交。 */
export function serializeConfig(config) {
  return `${JSON.stringify(renderDocument(config), undefined, 2)}\n`;
}

/** 同一路径上的写操作串行化链，避免并发写互相踩。 */
const writeChains = new Map();

/**
 * 把一次写操作排进该路径的串行链：前一个失败不阻断后一个。
 * ponytail: 链按路径常驻不回收，路径数等于工作区数量级（个位），不值得做引用计数。
 */
function enqueue(path, run) {
  const previous = writeChains.get(path) ?? Promise.resolve();
  const next = previous.then(run, run);
  writeChains.set(path, next.catch(() => {}));
  return next;
}

/**
 * 读-改-写一份配置：**读、`mutate`、写三步都在同一路径的串行链内**完成。
 *
 * 面板的写操作如果各自"先读快照、再写"，两次快速点击（或两个标签页）就会互相覆盖 —— 后写
 * 的那份带着旧快照，先写的那条改动凭空消失。把读放进链内即可消除丢失更新。
 * 另加两条防数据丢失规则：
 *  - 顶层未知键原样保留（本插件只管 `version`/`default`/`skills`/`mcp`）；
 *  - 文件存在但不是合法 JSON 对象时**拒绝写入**并报错，绝不拿空配置覆盖用户手工修的内容。
 *
 * 跨进程并发不在保护范围内（同一 DSH home 只有一个宿主进程持有配置）。
 * @param path - 目标文件绝对路径。
 * @param mutate - `(config) => config`；入参是磁盘上当前的归一化配置。
 * @returns 写入后的配置路径。
 */
export function updateConfigFile(path, mutate) {
  return enqueue(path, () => atomicUpdate(path, mutate));
}

/** {@link updateConfigFile} 的链内实现。 */
async function atomicUpdate(path, mutate) {
  const raw = await readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  const unknown = {};
  let document;
  if (raw !== undefined) {
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw new Error(`配置文件不是合法 JSON，已拒绝写入以免覆盖你的内容：${path}（${String(error?.message ?? error)}）`);
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(`配置文件顶层必须是 JSON 对象，已拒绝写入以免覆盖你的内容：${path}`);
    }
    for (const [key, value] of Object.entries(document)) {
      if (!MANAGED_KEYS.has(key)) unknown[key] = value;
    }
  }
  const next = renderDocument(mutate(normalizeConfig(document)));
  await atomicWrite(path, `${JSON.stringify({ ...unknown, ...next }, undefined, 2)}\n`);
  return path;
}

/** 单次原子写。 */
async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${(atomicWrite.counter = (atomicWrite.counter ?? 0) + 1)}`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

