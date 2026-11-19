/**
 * 技能目录枚举与正文读取。
 *
 * 两条刻意的取舍：
 *  1. **枚举走注册表，不自己扫盘** —— 注册表 summary 自带 `name`/`description`/
 *     `path`/`source`/`resourceBase`，自己写扫描器与 frontmatter 解析器只会与官方
 *     规则分歧，从而错判。
 *  2. **正文由本模块自己按 `path` 读** —— shadow provider 一旦赢了同名候选，
 *     注册表就会调用它的 `get()`；此时再委托 `ctx.skills.get()` 会重新选中自己，
 *     形成无限递归。所以这里复刻官方 `content = 去 frontmatter 后 body.trim()`
 *     的规则。
 *
 * @module dsh-workspace-capabilities/catalog
 */

import { readFile, stat } from 'node:fs/promises';

import { agentScopeMatch } from './cwd.js';

/**
 * 本插件**能接管**的技能来源：正文在磁盘上、可按 `path` 读到。
 *
 * `bundled`（office/badge 等，正文在包内 assets）与 runtime 技能不在其中 ——
 * 强行接管会让 `/名` 静默失效，面板把它们标为"不可管理"。
 */
export const MANAGEABLE_SOURCES = new Set(['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents']);

/** 来源的中文显示名，供面板使用。 */
export const SOURCE_LABELS = {
  'project-dsh': '项目 .dsh/skills',
  'project-agents': '项目 .agents/skills',
  custom: '自定义目录',
  'user-dsh': '~/.dsh/skills',
  'user-agents': '~/.agents/skills',
  bundled: '包内置',
  runtime: '运行时注册',
};

/**
 * 来源的展示顺序：作用范围由近到远，非文件系统来源排最后。
 *
 * 前五项与 `dsh-skill-filesystem` 的 `*_RANK`（100/200/300/400/500）同序 —— 面板顺序
 * 因此等于**同名冲突时的实际优先级**（近层赢）；`bundled`（600）与 `runtime`（250）与
 * 本工作区的作用范围无关，且都不可管理，统一排在最后，内部再看运行时 rank 会得到
 * "运行时注册在自定义目录之前"这种对使用者没有意义的顺序。
 *
 * 必须与 {@link SOURCE_LABELS} 的键集合一致（有单测守着，避免将来加来源时漏配）。
 */
export const SOURCE_ORDER = ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled', 'runtime'];

/**
 * 来源的排序权重；未知/缺失来源排在所有已知来源之后（它们之间再按名称排）。
 * @param source - 注册表给出的技能来源。
 * @returns 非负整数，越小越靠前。
 */
export function sourceRankOf(source) {
  const index = SOURCE_ORDER.indexOf(typeof source === 'string' ? source : '');
  return index < 0 ? SOURCE_ORDER.length : index;
}

/**
 * 面板排序：**可管理优先 → 来源 → 名称**。
 *
 * 参数是 {@link toCatalogRow} 之后、由 `rpc.js` 补过 `state` 的行。三层键构成稳定全序。
 * 名称用 `localeCompare`（而不是码点序）：它依赖进程 locale，所以这里承诺的是"同一进程内
 * 排序稳定且符合阅读习惯"，而不是跨机器逐字节一致。
 * @param left - 一行。
 * @param right - 另一行。
 * @returns 负数 / 0 / 正数。
 */
export function compareCatalogRows(left, right) {
  if (left.manageable !== right.manageable) return left.manageable === true ? -1 : 1;
  const bySource = sourceRankOf(left.source) - sourceRankOf(right.source);
  if (bySource !== 0) return bySource;
  return left.name.localeCompare(right.name);
}

/**
 * 模型目录里单条描述的截断上限，与 `dsh-tool-skill` 的默认 `catalogDescriptionMaxLength` 一致。
 * 只用于**估算**面板上的目录体量；真实值由宿主的插件配置决定。
 */
export const CATALOG_DESCRIPTION_MAX_LENGTH = 500;

/**
 * 一行的目录条目**字符数**（含结尾换行）。
 *
 * 复刻 `dsh-tool-skill` 的 `catalogDescription()`：空白折叠 + 超长截断成 `...`，
 * 再拼成 `` - `name`: description ``。`modelInvocable` 为假的行永远不会进目录，返回 0。
 * 与宿主的已知差异：宿主还会对描述做 `escapeText`（`&`/`<`/`>` 变实体），这里不做 ——
 * 描述里含这几个字符时本函数会低估几个字符，面板按"≈"展示，可接受。
 * @param row - 面板数据行（`{ name, description, invocation }`）。
 * @returns 字符数；不进目录时为 0。
 */
export function catalogCharsOf(row) {
  if (row?.invocation?.modelInvocable !== true) return 0;
  const raw = typeof row.description === 'string' ? row.description.replaceAll(/\s+/g, ' ').trim() : '';
  const description = raw.length <= CATALOG_DESCRIPTION_MAX_LENGTH ? raw : `${raw.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH - 3)}...`;
  return `- \`${String(row.name ?? '')}\`: ${description}`.length + 1;
}

/**
 * 该行此刻是否会被广告给模型。
 *
 * 两条路径的判据不同，不能合并：
 *  - 可管理行：本插件的 shadow provider 只降级 `manual`/`off`，所以只有 `pinned` 才进目录；
 *  - 不可管理行（bundled/runtime）：本插件不接管，注册表的 `invocation` 说了算。
 * 两者都要求 `modelInvocable` 为真（frontmatter 的 `disable-model-invocation` 会让它不进目录）。
 * @param row - 面板数据行（`{ manageable, state, invocation }`）。
 * @returns 是否在模型目录里。
 */
export function inModelCatalog(row) {
  if (row?.invocation?.modelInvocable !== true) return false;
  return row.manageable === true ? row.state === 'pinned' : true;
}

/**
 * 来源的显示名。
 *
 * 不能写成 `SOURCE_LABELS[source] ?? source ?? '未知来源'`：`source` 为空串时
 * `'' ?? …` 不触发兜底（空串不是 nullish），面板会显示成"技能正文不在磁盘上…"
 * 这种缺主语的句子。
 * @param source - 注册表给出的技能来源。
 * @returns 中文显示名；未知或缺失时返回 `未知来源`。
 */
export function sourceLabelOf(source) {
  if (typeof source !== 'string' || source === '') return '未知来源';
  return SOURCE_LABELS[source] ?? source;
}

/**
 * 判断一个注册表 summary 是否可被本插件管理。
 * @param skill - `ctx.skills.list()` 的元素。
 * @returns `{ manageable, reason }`；`reason` 仅在不可管理时有值。
 */
export function manageabilityOf(skill) {
  const source = typeof skill?.source === 'string' ? skill.source : '';
  if (!MANAGEABLE_SOURCES.has(source)) {
    return { manageable: false, reason: `${sourceLabelOf(source)}技能正文不在磁盘上，接管会让 /名 静默失效` };
  }
  if (typeof skill?.path !== 'string' || skill.path === '') {
    return { manageable: false, reason: '注册表未给出正文路径，无法按 path 重新读取' };
  }
  return { manageable: true, reason: undefined };
}

/**
 * 按官方规则剥掉 YAML frontmatter 并 trim 正文。
 *
 * 与 `dsh-skill-filesystem` 的 `parseFrontmatter` 同规则：首行必须是 `---`，
 * 其后第一行等于 `---` 的为闭合行（容忍 CRLF），正文从闭合行的下一行起。
 * @param raw - 文件全文。
 * @returns 正文；无合法 frontmatter 时返回 `undefined`（表示拒绝加载）。
 */
export function stripFrontmatter(raw) {
  if (typeof raw !== 'string') return undefined;
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) return undefined;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined;
  let lineStart = firstLineEnd + 1;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const bodyStart = nextNewline < 0 ? raw.length : nextNewline + 1;
      return raw.slice(bodyStart).trim();
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  // 循环不会走到这里：`lineStart` 只会被赋成 `nextNewline + 1 <= raw.length`，而进入
  // 循环后每条路径都会 return，所以循环条件恒真（与官方 `findClosingFrontmatter` 同形）。
}

/**
 * 读一个技能的正文（剥 frontmatter）。
 * @param path - SKILL.md（或单文件技能）的绝对路径。
 * @param signal - 取消信号。
 * @returns 正文；文件消失或无合法 frontmatter 时返回 `undefined`。
 */
export async function readSkillBody(path, signal) {
  let raw;
  try {
    raw = await readFile(path, 'utf8', signal === undefined ? {} : { signal });
  } catch {
    return undefined;
  }
  return stripFrontmatter(raw);
}

/** 取文件字节数，失败返回 undefined。 */
export async function fileSizeOf(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把注册表 summary 收敛成面板需要的一行。
 *
 * `invocation` 只是**注册表此刻的样子**，用来对照"配置想要的样子"；面板显示的状态
 * 一律以配置文件为准（冷读路径看不到 agent 层的降级，会把 manual/off 显示成启用态）。
 * @param skill - `ctx.skills.list()` 的元素。
 * @returns 面板数据行。
 */
export function toCatalogRow(skill) {
  const { manageable, reason } = manageabilityOf(skill);
  return {
    name: skill.name,
    description: skill.description,
    source: typeof skill.source === 'string' ? skill.source : '',
    sourceLabel: sourceLabelOf(skill.source),
    // provider 是排查"哪一层供的数"的唯一线索，面板暂未渲染但保留。
    provider: skill.provider,
    invocation: {
      modelInvocable: skill.invocation?.modelInvocable === true,
      userInvocable: skill.invocation?.userInvocable === true,
    },
    path: typeof skill.path === 'string' ? skill.path : undefined,
    manageable,
    reason,
    size: undefined,
  };
}

/**
 * 枚举一个 cwd 下能被当前进程看见的完整技能目录。
 *
 * 三个视图**取并集**（同名以更强的那个为准），因为任何单一视图都可能不完整：
 *  1. live agent 的 agent 层视图 —— 覆盖 global + preset + agent 三层，是唯一能看到
 *     本插件降级结果的一档；但**没有绑定 preset 的 agent**（例如 agent-loop 启动时就
 *     建好的 agent）只有自己那一层，会是空的；
 *  2. `agentPresets.acquireScope()` 拿到的 standing preset scope —— 无 live agent 或
 *     agent 视图为空时补齐；代价是看不到 agent 层降级；
 *  3. 纯 global 视图 —— 完全没有 session 时的最后一档，只能看到 bundled/runtime。
 *
 * @param ctx - host 插件上下文。
 * @param options - `{ cwd }`；用于选中**同项目根**的 agent（见 `cwd.js` 的 `agentScopeMatch`）。
 * @returns `{ rows, via, incomplete, notice }`。
 */
export async function collectCatalog(ctx, options = {}) {
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined;
  const agents = ctx.get('agents')?.list?.() ?? [];
  const usable = agents.filter((agent) => agent?.ctx?.get?.('skills') !== undefined);
  // 只认**同项目根**的 agent：`cd` 到子目录后原始 cwd 变了、作用域没变，按原始 cwd 相等
  // 会让面板退回 preset 视图（提示「没有活动会话」、MCP 探针失去核对能力）；跨项目根则
  // 绝不借用 —— 与 `rpc.js` 里 MCP 探针坚持的"不能拿别的 agent 顶替"是同一条原则。
  const matched = cwd === undefined ? undefined : await agentScopeMatch(ctx, cwd, usable);

  const merged = new Map();
  let via;
  let viewCwd = cwd;
  let notice;
  const agent = matched?.agent;

  if (matched !== undefined) {
    const skills = agent.ctx.get('skills');
    // 读取仍按 agent 的**当前目录**（可能是所选工作区的子目录）：项目根由 policy 解析，
    // 结论与所选工作区一致；也保证与宿主下一次模型步的读取目录一致。
    viewCwd = matched.cwd;
    for (const row of await skills.list({ cwd: viewCwd, scope: agent })) {
      if (row === null || typeof row !== 'object') continue;
      merged.set(row.name, row);
    }
    via = 'agent';
  }

  const presets = ctx.get('agentPresets');
  if (merged.size === 0 && presets !== undefined && typeof presets.acquireScope === 'function') {
    const lease = await presets.acquireScope();
    try {
      for (const row of await ctx.skills.list({ cwd: viewCwd, scope: lease.key })) {
        if (row === null || typeof row !== 'object' || merged.has(row.name)) continue;
        merged.set(row.name, row);
      }
      // 只有真的产出了行才算"目录来自 preset"，否则后面还要靠 global 兜底。
      if (merged.size > 0) via = 'preset';
    } finally {
      await lease[Symbol.asyncDispose]?.();
    }
  }

  if (merged.size === 0) {
    for (const row of await ctx.skills.list({ cwd: viewCwd })) {
      if (row === null || typeof row !== 'object' || merged.has(row.name)) continue;
      merged.set(row.name, row);
    }
    via = via ?? 'global';
  }

  // 提示按**实际生效的视图**给：`agent` 是唯一能看到 agent 层降级的视图，其余都要说明。
  if (via === 'preset') {
    notice = agent === undefined
      ? '当前工作区没有活动会话：目录取自 preset 作用域，agent 层的降级对它不可见'
      : '当前会话没有绑定 agent preset：目录取自 preset 作用域，agent 层的降级对它不可见';
  } else if (via === 'global') {
    notice = agent === undefined
      ? '当前没有活动会话也没有 preset：只能看到 host 全局层的技能'
      : '当前会话的 agent 层与 preset 层都没有技能：只能看到 host 全局层的技能';
  }

  return {
    rows: [...merged.values()],
    via,
    cwd: viewCwd,
    incomplete: via !== 'agent',
    notice,
  };
}
