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
 * 本模块只依赖 node 内置模块，不 import 任何 `@deepseek-ai/*`，因此不受宿主版本
 * 漂移影响。
 *
 * @module dsh-workspace-scope/config
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
      if (name === '' || name === 'default') continue;
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
  let bestPattern;
  for (const pattern of Object.keys(effective?.skills ?? {})) {
    if (!pattern.includes('*') && !pattern.includes('?')) continue;
    if (!globToRegExp(pattern).test(name)) continue;
    if (bestPattern === undefined || pattern.length > bestPattern.length || (pattern.length === bestPattern.length && pattern < bestPattern)) {
      bestPattern = pattern;
    }
  }
  if (bestPattern !== undefined) return effective.skills[bestPattern];
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
  const state = skillStateOf(effective, name);
  for (const pattern of Object.keys(effective?.skills ?? {})) {
    if (!pattern.includes('*') && !pattern.includes('?')) continue;
    if (globToRegExp(pattern).test(name) && effective.skills[pattern] === state) return { key: pattern, state };
  }
  return { key: undefined, state };
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

/** 序列化：稳定的键序 + 2 空格缩进 + 末尾换行，让 diff 可读、可提交。 */
export function serializeConfig(config) {
  const skills = {};
  for (const name of Object.keys(config.skills ?? {}).sort()) skills[name] = config.skills[name];
  const mcp = {};
  for (const server of Object.keys(config.mcp ?? {}).sort()) mcp[server] = config.mcp[server];
  const document = { version: CONFIG_VERSION, default: config.default ?? DEFAULT_STATE, skills, mcp };
  return `${JSON.stringify(document, undefined, 2)}\n`;
}

/** 同一路径上的写操作串行化链，避免并发写互相踩。 */
const writeChains = new Map();

/**
 * 原子写配置：`mkdir -p` → 写 `tmp-<pid>-<n>` → `rename`。
 *
 * 同一路径的并发调用被 promise 链串行化；失败不污染后续调用。
 * @param path - 目标文件绝对路径。
 * @param config - 要写入的配置文档。
 */
export function writeConfigFile(path, config) {
  const previous = writeChains.get(path) ?? Promise.resolve();
  const run = previous.then(
    () => atomicWrite(path, serializeConfig(config)),
    () => atomicWrite(path, serializeConfig(config)),
  );
  writeChains.set(path, run.catch(() => {}));
  return run;
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

