/**
 * `workingDirectory` 服务替身（供集成 harness 与目录发布探针共用）。
 *
 * 宿主 0.2.1 的 `WorkingDirectoryService` 同时暴露两个方法，替身必须都实现：
 *  - `get(session)`：只读投影状态，本插件用它区分「会话当前目录」与 `session.header.cwd`；
 *  - `ensure(agent, signal)`：`dsh-tool-skill` 的 `agent/pre-step` 用它求 cwd，缺这个方法
 *    时宿主插件根本不装配，目录消息一条都不会发布。
 *
 * 只实现其中一个的替身会让另一条路径静默退化（而且测试照样绿），所以收敛成一份。
 */

/**
 * 造一个替身：默认值取 `session.header.cwd`（与宿主投影的 `init` 一致），`set()` 模拟 `cd`。
 * @returns `{ get, ensure, set }`。
 */
export function createWorkingDirectoryStub() {
  const current = new WeakMap();
  const initialOf = (session) => session?.header?.cwd;
  return {
    /** 当前目录：`set()` 过就返回投影值，否则回落到会话初始目录。 */
    get: (session) => current.get(session) ?? initialOf(session),
    /** 会话当前目录（测试里不做文件系统校验与恢复）。 */
    ensure: async (agent) => current.get(agent?.session) ?? initialOf(agent?.session),
    /**
     * 模拟一次 `cd`：只更新投影状态，不广播 `session/event` —— 事件由各 harness 按宿主的
     * 语义（`working-directory/change`）自己发，避免把「状态」与「事件」揉成一个替身。
     * @param session - 会话对象。
     * @param path - 新的绝对目录。
     */
    set(session, path) {
      current.set(session, path);
    },
  };
}
