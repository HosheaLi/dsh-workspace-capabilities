/**
 * 会话「当前工作目录」的单一入口。
 *
 * 0.2.1 起宿主新增 `workingDirectory` 服务与会话内 `cd`（`working_directory` 工具）：
 * 会话的**当前**目录在该服务的投影状态里，`session.header.cwd` 只是创建时的初始目录。
 * 本插件按当前目录求工作区策略，才能和宿主的技能读取（`dsh-tool-skill` 也走
 * `workingDirectory.ensure`）保持一致；否则跨工作区 `cd` 后会出现「技能目录换了、
 * MCP 屏蔽与面板还停在原目录」的撕裂。
 *
 * 旧宿主没有这个服务：静默回落到 `session.header.cwd`，行为与 0.2.0 及更早一致。
 * 官方 `WorkingDirectoryService.get()` 只读投影、不做文件 I/O，所以这里可以放心在
 * 技能枚举、`tools/change` 补偿这类热路径上调用。
 *
 * @module dsh-workspace-scope/cwd
 */

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
