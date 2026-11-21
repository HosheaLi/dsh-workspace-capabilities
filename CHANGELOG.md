# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **编号说明**：开发期内部版本号曾是 `0.1.0`，转入迭代维护后重新编号为 `0.0.1`；首个公开发布版
> 定为 `0.1.0`，此后按语义化版本递增。历史方案见
> [`docs/archive/2026-10-11-workspace-capabilities-panel-plan.md`](docs/archive/2026-10-11-workspace-capabilities-panel-plan.md)。

## [0.1.1] - 2026-11-21

### 文档

- **发布状态口径同步**：npm、GitHub Release 与插件索引均已发布，修正 README / README.en 中
  「npm 包与 `v0.1.0` tag 尚未发布」的旧表述；Git 固定版本安装改用 `#v0.1.1`。
- **发布流程按 2026-11 的 npm 现实重写**：Granular access token 与 Bypass 2FA、staged publishing 的
  `0.0.0-stage` 占位与异步转正、2027-01 移除 bypass-2FA 直接发布的公告。

### 持续集成

- `release.yml` 改为幂等：版本已在 npm 时跳过 `npm publish`，`gh release create` 前先 `gh release view`，
  避免补推 tag 时因「版本已存在」把 workflow 跑红。

## [0.1.0] - 2026-11-19

### 发布

- **首个发布版**：包名从 `dsh-workspace-scope` 改为 `dsh-workspace-capabilities`，避免与 npm 上
  Ri0n72Y 的独立实现重名；插件行 id 仍是 `workspace-scope`，profiles 里的 id 覆盖不受影响。
- 补齐发布元数据：`repository` / `homepage` / `bugs` / `keywords` / `engines.dsh`、`locale/en.json`、
  `locale/zh.json`、`icon.svg`；新增 format 1 市场索引（`index.json`）与生成、校验脚本
  （`tools/build-market-index.mjs`、`tools/check-market-index.mjs`）。
- 发布流程与各社区渠道要求见 [`docs/publishing.md`](docs/publishing.md)。
- 发布工程：新增 Ubuntu 的 CI（`npm test` + 覆盖率门禁 95/90/80）与 tag 触发的
  npm + GitHub Release 工作流；新增 [`README.en.md`](README.en.md)、中英双语的兼容性矩阵与
  和 `dsh-workspace-scope` 的功能对照表。

### 界面

- **界面文案支持中英双语**：面板与输入框按钮的文案改为走宿主 `ctx.locale` 的 `t` 席位（注册
  `workspace-scope` 命名空间字典，插槽注册声明 `locale`），英文界面不再中英混排；宿主没有
  locale 服务（0.2.2 之前）时回落中文字典，行为与从前一致。技能名、描述、路径这些数据不翻译。
- **工作区能力面板排版与表格密度调整**：
  - 页头拆成三行：标题「工作区能力」独占一行并放大到 18px、简介换到第二行放大到 13px（均对齐
    原生设置页分区），「改动立即生效…」说明顺延到第三行。
  - 配置区从一行改成两行：工作区 / 默认状态各占一行；工作区下拉**只显示名称**，完整路径、
    项目根与写入层收进下拉右侧的信息图标；默认状态右侧的信息图标 hover / 聚焦后解释
    「自动注入 / 仅手动 / 关闭」的定义。
  - 工具栏改成「目录体量纯文本 → 统计胶囊（左对齐）→ 搜索栏」三行：搜索下移贴近表格，
    目录体量不再是胶囊。
  - 表格去掉描述后的「展开 / 收起」入口，描述保持 2 行预览、全文只由 hover 浮层给出；
    行内上下 padding 与列宽同步收紧。
  - 不可管理项（`bundled` / `runtime` 等）从主列表中拆出，收进表格末尾的折叠分组并**默认折叠**；
    组头显示数量与「配置对它无效」的原因，切换工作区后折叠态复位。
  - 批量条改成三行：第一行选中数量与目标状态，第二行「本次：目录…」左对齐，
    第三行「应用 / 恢复默认 / 清除选择」三个按钮固定在批量条最下方。

### 修复

- **Windows 上设置面板与 `/技能` 面板完全不可用**（2026-11-19 Windows 11 实机复现）：`lib/rpc.js`
  用 `cwd.startsWith('/')` 判绝对路径，真实 `C:\...` 一律被拒，`state` / `setSkill` / `setSkills` /
  `setDefault` / `setMcp` 全部返回 `cwd 必须是非空的绝对路径`。现改为 `node:path` 的 `isAbsolute`
  并按 `resolve` 归一；面板在 Windows 上是功能性阻断，不是显示问题。
- **工作区清单的跨平台归一**：`registryWorkspaces` / `listWorkspaces` / 读与写两份准入清单统一用
  `pathKey`（`resolve` + Windows 小写）建键与去重 —— 否则 `C:\Foo` 与 `c:\foo` 会重复出行、
  准入也会误拒。`agentScopeMatch` 的项目根比较同样改用该键。
- **会话工作区标题取整条路径**：`lib/rpc.js` 用 `root.split('/')` 取最后一段，Windows 路径不含 `/`，
  标题变成完整 `C:\...`；改用 `basename`。
- **`shortenPath` 只认 POSIX home**：`lib/client.js` 现在也把 `C:\Users\<名字>\...` 收敛成 `~\...`。
- **CI 恢复 Windows 矩阵**：`npm test` 在 `ubuntu-latest` 与 `windows-latest` 上跑，覆盖率门禁只在
  Ubuntu 上算；导出 `--test-coverage-exclude="test/**"` 消除 Node 22 / 26 的覆盖率分母差异。
- **UTF-8 BOM 的合法配置被判为损坏**（Windows 实测）：PowerShell 5.1 与「记事本另存为 UTF-8」
  会给文件加 BOM，`JSON.parse` 直接抛错，整份配置降级为空 → 技能静默回到目录。读、写两侧都先
  剥掉 `\uFEFF`。
- **损坏配置改为沿用上一次有效值**：`policy.js` 按文件路径记住最后一次成功解析的配置，坏文件
  沿用它并把 `error` 带出去（面板显示「已沿用上一次有效配置：…」）。原先的行为是静默回落空配置，
  手误一个字符就会让原本 `off` 的技能全部回到模型目录。进程首次启动即坏时仍回落空配置（无历史值）。
- **配置里出现过、但当前没有注册工具的 MCP server 从面板消失**：清单改为「已注册工具 ∪ 配置里
  出现过的名字」，否则用户在面板里关掉一个当前未运行的服务器后，再也找不到把它打开的入口。
- **`shortenPath` 的用户根边界**：`C:\Users\<名字>\` 与 `/Users/<名字>/` 现在收敛成 `~`
  （不带尾分隔符的用户根仍原样保留）。
- **文档补充「切换安装来源后必须重启 DSH」**：宿主 Loader 会持有首次装配时的绝对路径，
  源码 `link:` 与 Git 固定版本互换后，`install_bundle` 报 `applied` 也可能仍在跑旧代码。
- **client 半边的模块注册 id 与包名不一致**：`lib/client.js` 仍以 `dsh-workspace-scope` 调
  `window.__ModuleLoader__.load()`，改名后客户端报 `loaded without registering
  "dsh-workspace-capabilities"`，设置页不出现「工作区能力」。现已改为与包名一致，并同步更新
  槽位外部的注释与测试断言；localStorage 的工作区记忆键也一并改名（旧选择会重置一次）。
- **文档与实测数字校准**：README / README.en / architecture / development 统一到宿主
  `0.2.2-rc.5`、163 用例与 2026-11-19 的覆盖率（行 99.21% / 分支 88.04% / 函数 94.33%）。
  （2026-11-20 复核：`0.1.0` 之后新增的 i18n 用例把总数推到 172，四处数字随之改为
  172 用例 / 行 99.23% / 分支 88.28% / 函数 94.22%。）
- **子 agent 首个模型步抢跑 MCP 屏蔽**（`agent/created` 竞态）：MCP deny 与提示词遮蔽都要读盘，
  而子 agent 的创建在 `agent/created` 返回后立刻开始第一个模型步。原实现 fire-and-forget，
  子 agent 的首个 `request/header` 会拿到完整的 MCP 工具面（实测 306 个工具 / 234 个
  `mcp__rea__*`），server instructions 也仍在提示词里；主会话因创建早已完成而是对的，
  表现为「主会话关了、子 agent 还能调」。现在监听器 async 并 await 限制落地（宿主
  `ctx.serial` 会等待），`apply()` 也返回在途 Promise 供等待方复用。修复后同一探针为
  72 个工具 / 0 个 rea 工具。技能 shadow provider 是同步注册的，无此窗口。
- **HMR 重载后限制不再静默丢失**：deny 名单的工具表改从 agent 作用域的 `tools.schemas()` 读，
  不再访问插件 ctx 的 `ctx.tools` —— 重载窗口里插件 fiber 可能尚未 active，后者会抛
  `cannot get required service "tools" in inactive context`，让首次 apply 失败。

### 文档

- 新增三张真实界面截图（`docs/images/panel.png`、`skills.png`、`mcp.png`），中英文 README
  同步引用；补发布状态说明，避免把尚未公开的 npm / Git / 索引命令写成现在可用。

### 兼容

- **适配宿主 `0.2.1-rc.2`**（App 2026-10-17 更新）。插件依赖的宿主契约未变：
  `dsh-skill` 注册表（`collectCache` / `revision` / provider 协议）、`agentPresets.generations`、
  `tools.restrict`、`connection.requestRejection`、两个 client slot 的声明与 props 均与
  `0.2.0-rc.2` 一致。当时的实测：单测 122/122、集成 23/23、目录发布探针全部通过（当前基线见 `docs/development.md`）。
- 集成 harness 与探针补 `workingDirectory` 服务替身：`dsh-tool-skill` 在 0.2.1 的 `inject` 新增
  该服务，缺它时宿主插件不装配，目录发布用例会静默变成「0 条发布」。
- 文档同步宿主基线到 `0.2.1-rc.2`，并按新运行时复核 `architecture.md` 第 2、3 节的宿主行号。

### 功能

- **适配 0.2.1 的会话内 `cd`**（`working_directory` 工具）：新增 `lib/cwd.js` 作为「当前目录与
  工作区归属」的单一入口 —— `effectiveCwdOf()`（优先 `workingDirectory` 投影，取不到时回落
  `session.header.cwd`，旧宿主行为不变）、`scopeRootOf()` 与 `agentScopeMatch()`（与 policy 共用
  `findProjectRoot` 规则）。MCP 屏蔽、面板工作区清单、面板 MCP 探针、面板目录的 agent 匹配与读取
  全部改按当前目录；监听 `session/event` 的 `working-directory/change`，**先推进代际再重算** MCP
  deny（否则在途 apply 会用旧目录落地、把结果卡在旧目录）。面板的**归属判定按项目根**：项目内
  子目录 `cd` 不产生新的工作区行、也不丢失 agent 视图与 MCP 核对；**写盘准入仍是注册表 ∪ 会话
  初始目录**，`cd` 进入的新目录只可查看，不扩大插件写入面。详见 `docs/architecture.md` 2.5。
- **MCP 服务器提示词段随工作区隐藏**（`lib/prompt.js`）：`mcp` 开关此前只 deny 工具 schema，
  server instructions（`dsh-mcp-client` 在 host 层注册的 `mcp:<server>` 系统提示段）仍会进入
  每个工作区的提示词。现在对显式 `false` 的服务器，在 agent 作用域注册**同名空文本段**遮蔽它
  —— 依托 `dsh-system-prompt` 的「agent 作用域遮蔽同名全局段」语义，只影响该 agent，不碰其它
  工作区。`apply` 幂等、按 cwd 增删差异；`session/event` 的 `working-directory/change`、
  `tools/change`、面板写盘都会重算。新增 9 条单测（`test/prompt.test.js`）。
  **边界**：进程照常启动，省的是 token 不是内存。
- **设置面板重排（信息层级 + 可读性）**：
  - 顶部拆成「页头 / 配置区（工作区 · 默认状态 · 写入层）/ 工具栏 / 表格 / MCP」五段；工作区路径
    不再重复出现，写入层路径合并进配置行并以省略号 + `title` 兜长路径。
  - 统计从一句长句（`共 40 个技能：隐藏 7（关闭 7），不可管理 4 目录 ≈ … 默认 [自动注入]`）
    拆成工具栏右侧的三态胶囊 + 目录体量胶囊；`默认状态` 移到配置区，不再混在统计里。
  - 取消「可管理 + 来源」分组表头，来源独立成列；表头与数据行层次拉开，行 hover 有背景反馈。
  - 描述默认 2 行截断，点击整块展开全文并显示正文路径；hover 400ms 弹完整描述 + 来源 + 路径
    浮层，浮层可滚动、可复制（原先只有原生 `title`，使用者没有稳定途径看到全文）。来源从
    描述单元格末尾移到独立列。
  - 表头与短描述行等高（`minHeight` 两行），条目超过一屏（`46vh / 44px`）时底部提示表格内可滚动；
    面板/页面滚动、横向滚动、窗口缩放、筛选或写盘刷新时自动关闭浮层。
  - 改状态 / 改筛选后仍保持行序来自 host 的 `可管理 → 来源 → 名称`，面板不重排。

## [0.0.1] - 2026-10-15

首个基线版本：功能已在真实宿主上手工验收可用，代码与文档完成一轮整理归档。

### 功能

- **技能三态可见性**（按工作区）：`pinned` / `manual` / `off`。`manual` 是本插件的核心增量
  —— 模型看不见、`skill` 工具拒绝，但 `/技能名` 手动调用仍注入全文。
- **两层 shadow provider**：agent 层供模型目录与 `/名` 手势，preset 层供无活动 agent 的冷读
  （输入框 `/` 菜单、面板目录），两层结论一致。
- **MCP 工具可见性屏蔽**：按工作区 deny 无关 MCP 服务器的工具，含迟到注册与重连后的代际补偿。
- **工作区能力面板**（设置 → 工作区能力）：技能表格（勾选 / 名称 / 描述 / 状态下拉）、批量条、
  搜索、三层排序分组、MCP 服务器开关与可见工具数核对、目录体量估算与本次动作 Δ。
- **输入框 `/技能` 按钮**：搜索 + 点选插入 `/技能名 ` 并回焦。
- **两级配置**：项目级 `<项目根>/.dsh/skills-scope.json`（随仓库提交）优先于全局
  `$DSH_HOME/settings/skills-scope.json`；支持通配符；原子串行写盘；损坏文件拒写。
- **面板 RPC**：exact 路由 + **逐请求**过官方 `connection.requestRejection` 栅栏（无凭据 401、
  跨站 Origin 403），请求体上限 64 KiB。

### 修复

- **安全加固：面板 RPC 的回环 Host 判定收紧为官方同款**（`localhost` / `[::1]` / 四段十进制且
  首段为 `127` 的 IPv4 字面量）。原先的 `/^127\./` 前缀匹配会把 `127.0.0.1.evil.com`、
  `127.0.0.1.nip.io` 这类 DNS 记录由攻击者控制的域名当成回环 —— 这正是 DNS rebinding 的入口
  （仅在缺少 `connection` 服务的退化栅栏下生效）。已补回归用例，同时保留 127/8 合法字面量放行。
- **安全加固：面板 RPC 的 `cwd` 限定在面板会列出的工作区清单内**（`workspaceRegistry` ∪ 活动
  会话 cwd，与 `workspaces()` 同一数据源）。原先只校验「存在且是目录」，而 `findProjectRoot`
  找不到 `.git` 时兜底返回原 cwd，于是机器上任意已存在的目录都会被当成项目根、被 `mkdir -p`
  出 `.dsh/` 并写一份配置。已补回归用例断言拒绝时不留任何目录。
- 跨层清除不再「假成功」：`state: 'default'` 以「目标写盘层里真有这个精确键」为判据，
  键在另一层时返回 `noop` / 进 `skipped`，不写盘、不凭空建出空配置文件。
- 面板「删除显式配置」项与 host 共用同一判据，不再给出点了没反应的动作。
- 批量回执分三种文案，消除「未改动」与「跳过明细」自相矛盾。
- 单行状态下拉写盘后同样清空勾选，与文档口径一致。
- MCP 服务器名改按已知名字最长匹配，修掉 serverName 含 `__` 时开关静默失效。
- 修复设置面板首帧崩溃、技能描述列被压成 0 宽、分组 React key 相撞等回归。

### 文档

- **重写 `README.md`**：面向使用者（三态、配置、界面、生效时机与成本、安装、能力边界），
  深入内容移出。
- **新增 `docs/architecture.md`**：合并原 README 的「实现要点」与开发方案第 1 节的宿主机制事实，
  含运行时代码定位与探针实测数字。
- **新增 `docs/development.md`**：测试入口、覆盖率口径与浮动说明、探针用法、手工验收与维护检查清单。
- 补回「输入框 `/` 候选菜单按会话缓存、只在切换 agent preset 或连接重置时失效」这条时效说明
  —— 它是「改动立即生效」的唯一例外，此前仅存在于旧 README。
- 明确宿主升级后的必查项：两处**未公开的私有结构**（`skills.collectCache`、`agentPresets.generations`）
  失效时完全静默。
- **归档**：已实施完毕的方案原文移入 `docs/archive/`（头部标注归档状态、版本重新编号与行号漂移）；
  研究探针归位到 `tools/`。

### 测试

- `npm test`：**130 passed / 0 failed / 0 skipped**（108 单测 + 22 集成）。
- 覆盖率：**行 100.00% / 分支 ≈90%（实测 89.9–90.1，会抖）/ 函数 97.45%**。

### 工程

- 版本号定为 `0.0.1`；补 `LICENSE`（MIT）；项目自身的工作区配置 `.dsh/skills-scope.json` 纳入版本管理。
