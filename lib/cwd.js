/**
 * 会话「当前工作目录」与「工作区归属」的单一入口。
 *
 * 0.2.1 起宿主新增 `workingDirectory` 服务与会话内 `cd`（`working_directory` 工具）：
 * 会话的**当前**目录在该服务的投影状态里，`session.header.cwd` 只是创建时的初始目录。
 * 本插件按当前目录求工作区策略，才能和宿主的技能读取（`dsh-tool-skill` 也走
 * `workingDirectory.ensure`）保持一致；否则跨工作区 `cd` 后会出现「技能目录换了、
 * MCP 屏蔽与面板还停在原目录」的撕裂。
 *
 * 旧宿主没有这个服务：静默回落到 `session.header.cwd`，行为与 0.2.0 及更早一致。
 * 官方 `WorkingDirectoryService.get()` 只读投影、不做文件 I/O，所以这里可以放心在
 * 技能枚举、`tools/change` 补偿这类热路径上调用；但它对**没有记录初始目录**的会话会返回
 * 服务的 `defaultDirectory`（宿主进程目录），因此写盘准入只认 `session.header.cwd`
 * 一级的目录（见 `rpc.js` 的 `writableWorkspacePaths()`），不让服务默认值扩大写入面。
 *
 * 本文件还提供「哪个 agent 属于某个工作区」的唯一判定：作用域单位是**项目根**，
 * 不是原始 cwd —— 会话 `cd` 到项目子目录时项目根不变、配置结论也不变，面板不应该
 * 因此把它当成另一个工作区。`catalog.js` 与 `rpc.js` 共用这一处判定。
 *
 * @module dsh-workspace-capabilities/cwd
 */

import { findProjectRoot } from './config.js';

/**
 * 取一个 agent 会话的当前工作目录。
 *
 * 服务读取失败（会话还没注册投影、测试替身没实现等）一律回落到 header：目录解析
 * 不该让技能枚举或 MCP 补偿整条断掉。
 *
 * @param ctx - host 插件上下文；可为空。
 * @param agent - agent 对象。
 * @returns 绝对路径；会话与 header 都没有时返回 `undefined`。
 */
export function effectiveCwdOf(ctx, agent) {
  const session = agent?.session;
  if (session === undefined || session === null) return undefined;

  let service;
  try {
    service = ctx?.get?.('workingDirectory');
  } catch {
    service = undefined;
  }

  let current;
  try {
    current = service?.get?.(session);
  } catch {
    current = undefined;
  }
  if (typeof current === 'string' && current !== '') return current;

  const header = session.header?.cwd;
  return typeof header === 'string' && header !== '' ? header : undefined;
}

/**
 * 取一个 agent 当前所在的**项目根**（本插件的作用域单位）。
 *
 * 与 `policy.read()` 解析配置用的是同一条规则（`config.js` 的 `findProjectRoot`）：
 * 最近的含 `.git` 的祖先，找不到就退回 cwd 自身。子目录 `cd` 因此仍落在同一作用域。
 *
 * @param ctx - host 插件上下文；可为空。
 * @param agent - agent 对象。
 * @returns 项目根绝对路径；会话没有可用目录时返回 `undefined`。
 */
export async function scopeRootOf(ctx, agent) {
  const cwd = effectiveCwdOf(ctx, agent);
  return cwd === undefined ? undefined : findProjectRoot(cwd);
}

/**
 * 在候选 agent 里找与 `cwd` **属于同一项目根**的那一个。
 *
 * 判定必须是项目根而不是原始 cwd：`cd` 到项目子目录后原始 cwd 变了、作用域没变，
 * 按原始 cwd 相等会让面板退回 preset 视图（「当前工作区没有活动会话」的误导提示、
 * MCP 探针失去核对能力）。同时也不能退而取任意 agent —— 别的项目根有自己的配置。
 *
 * @param ctx - host 插件上下文。
 * @param cwd - 面板/调用方给出的目录（通常是注册表工作区路径）。
 * @param candidates - 候选 agent（调用方负责先过滤出可用的那些）。
 * @returns `{ agent, cwd }`：命中的 agent 及其当前目录；没有匹配返回 `undefined`。
 */
export async function agentScopeMatch(ctx, cwd, candidates) {
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  const root = await findProjectRoot(cwd);
  for (const candidate of candidates ?? []) {
    const current = effectiveCwdOf(ctx, candidate);
    if (current === undefined) continue;
    if (await findProjectRoot(current) === root) return { agent: candidate, cwd: current };
  }
  return undefined;
}
