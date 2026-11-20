# STATE — dsh-workspace-capabilities

> 三栏：进度 / 决策 / 阻塞。初值取自 2026-11-20 的第 0 步判定（命令与原始输出见当次汇报）。
> 每个任务完成后更新本文件；`bash scripts/wrapup.sh` 会提醒。
> 计划本身在 [`docs/PLAN.md`](../docs/PLAN.md)，这里只记「现在到哪了、为什么这么走、卡在哪」。

## 进度

| 项 | 状态 | 证据 / 备注 |
| --- | --- | --- |
| 代码 | 完成 | `npm test` 172 用例：149 通过 / 23 跳过 / 0 失败（2026-11-20） |
| 覆盖率门禁 | 通过 | 行 99.23% / 分支 88.28% / 函数 94.22%，门槛 95/90/80 |
| 统一验证入口 | 完成 | `scripts/verify.sh` 首次真跑通过（构建替代项 + lint 替代项 + test + coverage）；失败路径已用临时坏文件验证过退出码 1 |
| CI | 已核实（2026-11-20） | `02dcb5a`（当前 HEAD）run 44555345566：`test (ubuntu-latest)` 与 `test (windows-latest)` 均 success；覆盖率门禁 Ubuntu 通过、Windows 按设计跳过 |
| 文档 | 已对齐（2026-11-20） | 用例数 8 处改成 172/149，覆盖率表重测，README 支持范围改为「仅 macOS、Windows 开发中」 |
| 集成测试 | 跳过中 | 缺 `/tmp/dshref/runtime`，23 条整组 skip（含宿主发布语义与 RPC 全链路） |
| npm 发布 | 未发布 | `npm view dsh-workspace-capabilities version` → 404（2026-11-20） |
| Git tag | 本地有、远端无 | 本地 `v0.1.0` 存在；`git ls-remote --tags origin` 无输出 |
| Windows 实机 | 未验证 | README 已如实写「开发中，近期更新」；CI 只覆盖单测，面板无实机证据 |
| 本机运行 | 在用 | `~/.dsh/profiles/desktop/node_modules/dsh-workspace-capabilities` 软链到本仓库，`cordis.patch.yml` 已 insert `workspace-scope` |
| 三件套 | 完成 | `AGENTS.md` / `docs/PLAN.md` / `.planning/STATE.md`（2026-11-20 新建） |
| 提交策略 | 已改为每轮自动本地提交 | `AGENTS.md` 红线 8；`scripts/wrapup.sh --commit`（敏感命中拒绝提交、永不 push），已在临时克隆验过正反两条路径 |
| npm 发布文档 | 完成 | `docs/publishing.md` 新增「手动 npm 发布」8 小节（前置检查 → 打包预演 → 发布 → 复核 → 索引 → 与 tag 二选一 → 回滚） |

## 决策

| 日期 | 决策 | 理由 |
| --- | --- | --- |
| 2026-11-20 | 项目判定为**活跃**，不做冻结卡 | 24h 内提交、工作区干净、插件正被本机 desktop profile 实际使用、覆盖率过门禁 |
| 2026-11-20 | `scripts/verify.sh` 不装任何依赖、不 `npm install` | 本仓库零运行时依赖是刻意设计（`package.json` 无 dependencies），加安装步骤会破坏这个边界 |
| 2026-11-20 | 构建门禁用 `node --check` 语法自检代替 | 没有构建步骤（`lib/client.js` 是手写 bundle 直出产物）。不假装有构建，退一步做能抓语法错误的检查，并在脚本注释写明它抓不住类型与逻辑错误 |
| 2026-11-20 | 不新立 lint 标准 | 仓库没有 eslint/prettier/biome/editorconfig，CI 也没有 lint 步骤。只做 `git diff --check` 与 JSON 可解析两项客观检查，避免引入一套与项目无关的规范 |
| 2026-11-20 | `check:index` 在 verify 里是**可选**步骤 | 需要官方校验器 `@deepseek-ai/dsh-plugin-market-index`，本包零依赖不自动装；缺了就打印跳过原因，不计失败，避免「发布检查没跑」被误读成「测试红了」 |
| 2026-11-20 | 覆盖率门禁进 verify 但可用 `--no-coverage` 跳过 | 它是 CI 的真实门禁（行 95/90/80），2 秒成本值得；跳过时脚本显式声明「不等价于 CI」 |
| 2026-11-20 | 文档偏差只记录、不在本轮修改 | 本轮任务是搭验证与交付骨架；改 8 处用例数属于阶段 1 的活，已在 `docs/PLAN.md` 排进去 |
| 2026-11-20 | 第一轮已修完文档偏差 | 用例数、覆盖率表、README 支持范围全部对齐实测；CHANGELOG 的 0.1.0 历史数字保留并补复核说明，不覆盖已发布记录 |
| 2026-11-20 | README 支持范围如实改为「仅 macOS，Windows 开发中」 | CI 的 Windows 作业只证明单测能过，面板无实机证据；写「支持」就是造假 |
| 2026-11-20 | 提交策略改为每轮自动**本地**提交，仍不 push | 用户明确要求；push 到公开仓库是人的决定，不进自动化。`wrapup.sh --commit` 带敏感扫描闸 |
| 2026-11-20 | npm 手动发布与 tag 触发 release 互斥 | 同一版本二次 `npm publish` 会失败；文档里写明二选一，避免把 workflow 推红 |

## 阻塞

| 项 | 阻塞点 | 谁能解 / 怎么解 |
| --- | --- | --- |
| npm 发布 | 需要 `NPM_TOKEN`（npm 账号权限），无它时 `release.yml` 会在 publish 步失败 | **需要人**：配置仓库 secret 后推 `v0.1.0` tag |
| Windows 实机复核 | 本机是 macOS，无 Windows 机器 | **需要人**：找一台 Windows 11 跑「手工验收」五步并留证据 |
| 23 条集成测试 | `/tmp/dshref/runtime` 不存在（一次性解包即可，非人力阻塞） | 可自动做：解包 App 内 `dsh/`（`docs/development.md`「解包运行时」），已排进阶段 2 |
| ~~CI 运行状态~~ | 已解：`gh` 走 api 被 VPN 重置，改用 `curl api.github.com` 拿到 run 44555345566 两作业 success | — |

## 未验证（不要当结论用）

- ~~CI 是否绿~~已核实到 `02dcb5a`；**本轮的改动没有被 CI 验证过**（改动没推送，CI 只跑到上一个 commit）。
- Windows 上面板是否真的可用 —— 只有 CI 单测覆盖，没有实机证据。
- Web（`0.2.1-rc.5`）兼容性 —— README 写「预期可用」，无实测。
- `docs/architecture.md` 里引用的宿主行号是否仍准确 —— 文档自己注明「2026-11-19 复核运行与测试，但没逐条复核行号」，本轮也没复核。
