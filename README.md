# dsh-workspace-scope

按**工作区（项目目录）**决定技能是否进入模型目录，并屏蔽与本项目无关的 MCP 服务器工具。

一句话语义：把某个技能标成 `manual` 之后，**模型看不见它，但 `/技能名` 手动调用照样注入全文**。市面上两个"覆盖型"技能插件都选择彻底停用（`/名` 一起死掉），这一档是本插件的核心增量。

## 三种状态

| 状态 | 进 `<available_skills>` | `skill` 工具 | `/名` 手势 | 用途 |
| --- | --- | --- | --- | --- |
| `pinned`（默认） | ✅ | ✅ | ✅ | 本工作区常用技能，交给模型自选 |
| `manual` | ❌ | ❌ | ✅ | "关闭自动注入"，靠面板点选或手打调用 |
| `off` | ❌ | ❌ | ❌ | 与本工作区完全无关 |

默认值是 `pinned`：装上插件不产生任何行为突变，再由你在工作区里把不需要的标掉。

## 配置

两级，项目级优先，键为技能名或通配符：

```jsonc
// <项目根>/.dsh/skills-scope.json —— 随仓库提交，团队共享
{
  "version": 1,
  "default": "pinned",
  "skills": {
    "writing-for-agents": "manual",
    "comfy-*": "off"
  },
  "mcp": { "comfy": false }
}
```

```jsonc
// $DSH_HOME/settings/skills-scope.json —— 全局默认
{ "version": 1, "default": "pinned", "skills": {}, "mcp": {} }
```

- **项目根**沿用 DSH 判定：最近的含 `.git` 的祖先目录，没有则用当前 cwd。
- **路径刻意分离**：官方 `findProjectRoot` 在没有 `.git` 祖先时兜底返回原始 cwd，而 `~` 下没有 `.git`，所以在 home 目录里工作时"项目根"就是 home。全局配置放在 `$DSH_HOME/settings/` 而不是 `$DSH_HOME/` 根，并且**项目根等于 home 时跳过项目层** —— 否则两级配置会变成同一个文件，静默互相覆盖。
- **匹配优先级**：精确名 > 通配符（多个命中取最长模式）> `default`。
- **`default` 只在显式设置过时才落盘**：缺省写一个默认值等于把它物化成显式配置，而项目层优先，于是"在项目里关掉一个技能"会顺带用 `pinned` 盖掉你全局设的 `manual`/`off`。
- **写盘**：`mkdir -p` → 写 `tmp-<pid>-<n>` → `rename`；**读-改-写整条链在同一路径上串行**（两次快速点击不会互相覆盖），顶层未知键原样保留（向前兼容），文件存在但不是合法 JSON 时**拒绝写入并报错**，绝不拿空配置覆盖你手工修的内容。

## 界面

| 位置 | 内容 |
| --- | --- |
| 设置 → **工作区能力** | 工作区选择、技能表格（勾选框 / 名称 / 描述 / 状态下拉，按"可管理 + 来源"分组）、批量条、搜索、只看非默认项、默认状态、MCP 服务器开关（含"可见 x/y"核对）、当前项目根与配置来源、目录体量估算 |
| 输入框右侧 **`/技能`** 按钮 | 搜索 + 点选 → 插入 `/技能名 ` 到输入框并回焦 |

**状态列是原生下拉**：自动注入 / 仅手动 / 关闭；该行有精确配置键时多一项「**删除显式配置（→ 回落态）**」——回落态由 host 按**写入层**算好，标注删掉这个键之后实际会落到哪一态；不可管理行整列禁用。**键在另一层时这一项不会出现**（例如精确键在全局层、默认却写项目层）：删掉它不会改变生效状态，host 因此不给出一个点了没反应的动作——`setSkill` 这时返回 `noop`，既不写盘、也不会凭空建出一个空的项目层配置；要清它得去改**那一层**的配置文件（面板固定写项目层，有项目层时不会动全局层的键）。

**最左是勾选列 + 批量条**：表头勾选框 = 全选 / 取消全选**当前筛选结果里的可管理行**（一个可管理行都没有时禁用），不可管理行的勾选框禁用（title 写原因）。勾选集**跨搜索/筛选保留**，但切换工作区与写盘成功后清空——避免"看不见的选中项"被批量改掉。批量条只在有选中项时出现：

```text
已选 3 项（当前筛选 31 项） 设为 [自动注入 ▾] [应用] [恢复默认] [清除选择] ｜ 本次：目录 -1.7k 字符 ｜ 目录变化会在会话里追加 1 份完整目录
```

批量走**一次**原子 RPC `setSkills({ cwd, names, state })`——N 个名字一次读-改-写、一次缓存失效（为什么要批量见下节：N 次单条写盘一旦跨过模型步，就会变成 N 份目录）。会被跳过并**逐条回报原因**的行有四类：不可管理、当前目录里不存在、`default` 却命中的是通配符/默认（没有可清除的显式键）、`default` 而精确键**不在写入层**；已经是目标值的行直接略过（不进回执）。真无操作时返回 `noop` 且**根本不写盘**。

`恢复默认` 同样只删**写入层**里的精确键：键在另一层的行会被跳过并回报「显式配置不在写入层（项目层|全局层），删除它不会改变生效状态」。写盘后的回执分三种情形，避免自相矛盾：

| 情形 | 回执 |
| --- | --- |
| 有改动的 | `已改 N 项`（有跳过时追加 `；跳过 M 项：名字（原因）`） |
| 全部被跳过 | `未做任何改动；跳过 M 项：名字（原因）` |
| 全部已是目标值 | `所选技能已经是目标状态，未写盘` |

**描述列 2 行截断**（`-webkit-line-clamp: 2`，`title` 保留全文）——腾出的宽度来自状态列（3 个按钮 + 清除按钮 → 1 个下拉）；**来源不再单占一列**，作为描述单元格末尾的标签（`flex: 0 0 auto`，不参与压缩）并由分组表头共同承担。技能单元格第二行则是 `显式配置 · 1.2 KB` 这样的元信息（配置命中方式 + 正文体积）。**不可管理行也能看到自己的描述**：以前描述列渲染的是 `reason`，把描述顶掉了；现在 `reason` 挂在"不可管理"徽标的 tooltip 上，"未生效?"徽标同在技能名旁。

**排序三层**（`compareCatalogRows`，在 host 侧排好，面板与 `/技能` 浮层共用同一顺序）：可管理优先 → 来源（`project-dsh` → `project-agents` → `custom` → `user-dsh` → `user-agents` → `bundled` → `runtime`，未知/空来源最后）→ 名称。前五个来源的顺序与 `dsh-skill-filesystem` 的 `*_RANK` 完全一致，所以**面板顺序 = 同名冲突时的真实优先级**；表格按 `(可管理, 来源)` 插入分组表头（如 `可管理 · 项目 .dsh/skills（3）`），空分组不渲染。

面板的**状态列一律以本插件配置文件为准**，不拿注册表返回的 invocation 反推：invocation 只作交叉核对——配置说"不该自动注入"而注册表仍显示可被模型调用时，该行会给一个"未生效?"标记。（冷读路径用的是 preset 作用域、看不见 agent 层的降级，所以本插件在 **preset 层也注册了一份 shadow provider**，让冷读与 agent 读给出同一结论——见"实现要点"。）

## 改配置对进行中的会话意味着什么

一句话：**立即生效，但每次目录变化都会在会话里永久追加一份完整目录——所以批量改，别反复横跳。**

技能目录不是系统提示词的一部分，而是会话里一条普通的 durable **user 消息**：`dsh-tool-skill` 的 `agent/pre-step` 中间件在**每一个模型步**重算注册表快照的 digest（`dsh-agent-loop` 在**一个 turn 内每个 step 都调 `preStep()`**，不是每轮对话一次）。

| 你做了什么 | 会话里发生什么 |
| --- | --- |
| 写盘了但目录内容没变 | **完全静默**，零成本 |
| 目录内容变了 | **追加**一条带全量 `<available_skills>` 的替代消息（`renderCatalogUpdate`，不是就地替换、不是差量） |
| 关掉某技能又打开 | 算**两次**变化 → 两次追加 |

- **成本**：改 k 次 ≈ 该会话永久多 k 份目录，每份都是全量。本机 31 条技能目录约 **4.5k 字符/份**（≈1.2k token；中文占比重时上限约 2.6k，估算值）。探针实测（3 个技能）：首次发布 780 字符，变化后的 update 612 字符；4 次目录变化后会话里累计 4 条目录消息——目录消息只增不减，直到压缩（compaction）动到它（探针打印的「累计 1971 字符」对应其中前 3 条）。
- **生效时机**：下一个模型步——**同一回合里继续调工具的那一步也算**；不需要重启 App、不需要重开会话（与"改 `cordis.patch.yml` 要重启"是两回事）。
- **调用路径是现查的**：`skill` 工具与 `/技能名` 手势都在调用那一刻读注册表，所以 `off` 立即失效、`manual` 仍可 `/技能名`。
- **输入框 `/` 候选菜单是另一条路**：菜单数据来自宿主 `SessionSkillCatalog.list`。会话**已有活动 agent** 时它读 agent 作用域；**没有**（刚新建、还没发过消息）时回落到 preset standing scope —— 这正是本插件要在 preset 层再注册一份 provider 的原因，否则被关掉的技能照样出现在菜单里，选中插入后又静默不注入（看起来"关了还能用斜杠调用"）。注意 client 对这份目录**按会话缓存**，只在切换 agent preset 或连接重置时失效：改完配置后，已经打开过的会话里的菜单要等这次失效才刷新，新会话/重连则立即是新目录。
- **不回收历史**：已经进过上下文的技能正文留在历史里，标成 `off` 只是让**以后**不再加载；旧目录消息也不会被删除。
- **一次性代价**：目录消息位置靠前，一次变化就会打断一次前缀缓存（prompt cache）。

这些代价在面板上是可见的：工具栏常驻 `目录 ≈ 4.5k 字符 / 31 条`（字符数按宿主渲染规则估算，token 换算只放在 tooltip 里）、批量条给出本次动作的 Δ（`目录 -1.7k 字符` / `目录大小不变`）并注明会追加 1 份完整目录、头部常驻一行「改动立即生效……每次目录变化会在每个受影响会话里追加一份完整目录」。要自己复核机制，跑仓库里的探针：

```bash
DSH_RUNTIME_DIR=/tmp/dshref/runtime node docs/probe-skill-catalog-publish.mjs
```

完整代码定位与逐条实测见 [`docs/workspace-capabilities-panel-plan.md`](docs/workspace-capabilities-panel-plan.md) 第 1 节。

## 安装

### 方式一：作为 profile bundle（推荐）

1. 让包能被 profile 解析到，例如软链到 profile 目录：

   ```bash
   mkdir -p ~/.dsh/profiles/desktop/node_modules
   ln -sfn ~/code/D03_dsh-workspace-scope ~/.dsh/profiles/desktop/node_modules/dsh-workspace-scope
   ```

2. 在 profile 的 `cordis.patch.yml` 里插一行：

   ```yaml
   - insert:
       - id: workspace-scope
         name: 'dsh-workspace-scope'
   ```

`client` 半边由 `package.json` 的 `dsh.client` 声明自动加载，不需要单独插行。

### 方式二：加进 `dsh.profile.bundles`

在 profile 的 `package.json` 里把 `dsh-workspace-scope` 追加到 `dsh.profile.bundles`，随 profile 一起升级。

**两种方式都需要重启宿主进程**（host 与 client 半边都在启动时装配）。

## 实现要点

- **零 `@deepseek-ai/*` 依赖**：host 半边只用 node 内置模块，不随宿主版本漂移；因此也不需要 peer 版本豁免。
- **两层 shadow provider，缺一不可**（`skills.js` + `preset.js`）：
  - **agent 层**（`agent.ctx.get('skills')`）供模型目录与 `/名` 手势；注册在 host 全局层会被 preset 层静默盖掉。
  - **preset 层**供**没有活动 agent** 的冷读（`/` 菜单、面板目录）。宿主在注册 preset 定义时就 mount 了一份 standing 组合（与有没有 agent 无关），`generations` 是 registry 的运行时字段，`generation.scope.ctx` 就是那份组合的上下文、`scopeOf(它)` 正是冷读用的 `lease.key`。读不到这层结构时**安静退化**（保持 agent 层行为，只记一条 warn），启动期用有界重试兜住"preset 定义注册晚于本插件 apply"的装配顺序。
  - **同层内 rank 0 必胜**：官方 `dsh-skill-filesystem` 的项目/用户/bundled 根 rank 是 100/200/300/400/500/600，`compareIndexedCandidates` 按 rank 升序取先到者，所以同层里本插件的降级候选稳定赢过原候选。
- **内层读的缓存必须丢掉**：`list()` 内部要读"未降级的全量目录"，这次读会被注册表写进 `collectCache`。`layers` 是全局共享的，但 `collectCache` **每实例一份**，而外层覆盖内层写入只发生在**同一个实例**上 —— agent 读会经注册表调用 preset 层的 provider，那个内层读落在 **preset 实例**上，于是一份"未降级目录"被缓存下来，之后的冷读命中它、降级就丢了（表现为"先读 agent、再读 `/` 菜单，`off` 技能又出现了"）。所以内层读返回后只删**本次新增**的缓存键：删多了最坏是多扫一次目录，不会给出错误结果；`collectCache` 被并发调用换掉时直接跳过，不碰别人的表。
- **shadow provider 注册在 agent 层**（`agent.ctx.get('skills')`，不是属性访问）。技能注册表按层合并，`layers = [global, ...chainLayers(scope)]` 逐层覆盖，**近层直接赢、与 rank 无关**；注册到 host 全局层会被 preset 层静默盖掉，过滤完全不生效。rank 取 0 只是同层内的保险。
- **重入哨兵**：`list()` 内部要读注册表，会重新进入自己。内层调用返回空候选，外层拿到"未降级的全量目录"构造降级候选；注册表在外层 collect 结束时用它覆盖内层写入的缓存。判据是**同一条 async 调用链**（`AsyncLocalStorage`），不是"同一个 cwd"：按 cwd 记名的集合会把两个独立调用者的并发枚举也当成重入，让后来者拿到未降级目录、把 `manual`/`off` 技能重新广告给模型。
- **`get()` 自己读正文**：赢家是自己，委托 `ctx.skills.get()` 会无限递归。正文按官方规则取（去 frontmatter 后 `body.trim()`）。
- **`tools.restrict` 三段式防护**：restrict 会**同步** emit `tools/change`，无条件重注册会同步递归到栈溢出、卡死整个 dsh 进程。防护是 ①哨兵 ②deny 集合比较 ③先删记账再 dispose。另有**代际补偿**：读盘期间若又有工具注册进来，重算而不是被哨兵静静吞掉 —— 这一条覆盖"MCP 服务器重连后工具重新出现"。
- **面板 RPC 逐请求过栅栏**：`webServer` 的 exact 表优先于 Connection 的 `/api` prefix 表，而 `connection` 服务的就绪时机晚于插件 apply。所以注册可以早、**鉴权必须逐请求做**，优先复用官方 `connection.requestRejection`（Host/Origin 反 DNS-rebinding + 浏览器会话 cookie/进程 token），它不在时才退化为"回环 Host + 同源 Origin"。无凭据 → 401，跨站 Origin → 403。
- **批量写盘只落一次盘**：`setSkills` 把 N 个名字合成一次读-改-写（`withSkillState` / `withoutSkillState` reduce → 一次 `updateConfigFile`，内部按路径串行 + 原子 rename），并把"已经是目标值"的行排除出写集合——写盘本身不花钱，但目录 digest 一变就会在每个受影响会话里追加一份完整目录；全部无变化时连文件都不碰。

## 能力边界（第一版）

只有**文件系统来源**的技能可被管理：`source` ∈ `project-dsh` / `project-agents` / `custom` / `user-dsh` / `user-agents`，且注册表给出了 `path`。

`bundled`（office/badge 等，正文在包内 assets）与 `runtime` 注册的技能在面板中标为"不可管理"并给出原因 —— 接管它们需要本插件在 `get()` 里复现正文，而正文来自包内 assets 或运行时拼接，做不到；强行接管会让 `/名` 静默失效。

**冷读路径**：没有任何活动会话时（或会话未绑定 agent preset 时），面板与 `/` 菜单的目录来自 preset 作用域 —— 本插件在 preset 层同样注册了 shadow provider，那里的 `manual`/`off` 降级与 agent 读结论一致；面板仍会把该目录标为 `incomplete` 并说明来源。面板**只认与所选工作区 cwd 完全匹配的 agent**：工作区没有活动会话时不会借用别处的 agent 视图，而是回落到 preset / 全局并在面板上说明。

## 开发与测试

```bash
# 全部测试：纯 JS 单测 + 集成测试（当前 128 passed / 0 skipped）。缺解包运行时目录时，
# 集成用例整体 skip，所以新克隆直接 npm test 不会变红（输出里的 skipped 数会告诉你跳过了几条）。
npm test

# 只跑纯 JS 单测（无宿主依赖）—— test/config.test.js / rpc.test.js / client.test.js / render.test.js / catalog.test.js / policy.test.js / mcp.test.js / skills.test.js / preset.test.js / index.test.js
npm run test:unit

# 只跑集成测试：在真实的 0.2.0-rc.2 运行时上跑（当前 21 passed / 0 skipped；缺运行时 21 skipped）
# 先从 App 包里解出运行时：<app.asar>/dsh → /tmp/dshref/runtime
DSH_RUNTIME_DIR=/tmp/dshref/runtime npm run test:integration

# 覆盖率（10 个 lib 文件，当前行 100.00% / 分支 89.99% / 函数 97.41%）
DSH_RUNTIME_DIR=/tmp/dshref/runtime node --test --experimental-test-coverage "test/**/*.test.js"
```

**覆盖率口径**：`lib/client.js` 的测试通过 `test/helpers/client-bundle.js` **每个进程只 import 一次**。早先用 `?t=<n>` 绕 ESM 缓存会让同一文件产生多个脚本实例，而覆盖率报告只保留其中一个，数字会被压低一半以上，补测试也看不出来。

**分支覆盖会小幅浮动**：修完审查问题后复跑 13 次实测 89.44%（11 次）/ 89.34%（1 次）/ 89.24%（1 次），波动来自既有 `config.js` / `mcp.js` 里依赖时序的分支命中与否（行覆盖稳定 100.00%），与技能面板这轮改动无关。加上 preset 层之后单次实测 89.99%（行覆盖仍 100.00%）。

**注意用 App 自带的 node**（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`，v24）：在系统 Node 上跑 **dsh 本体**、加载宿主原生模块时会报 `No usable native binding found for node-addon-require-builtin-darwin-arm64`。本插件的测试不触发该路径（实测系统 Node v25.9.0 全绿），但装插件、跑宿主仍请用 App 自带的 node。

覆盖范围：agent 层 shadow 赢过 preset 层的 filesystem provider、preset 层绑定（scope 探测、幂等、retired/重建回收、有界重试、卸载取消、结构畸形与注册冲突时安静退化）、内层读的缓存丢弃（跨实例污染、并发换表时不误伤）、冷读路径（**没有活动 agent** 时 preset 作用域也按工作区策略降级，且与 agent 读结论一致）、注册表 `invocation` 三态语义（`/名` 手势与 `skill` 工具的**实际**拒绝由运行时 `dsh-tool-skill` 保证，测试只断言注册表视图）、同 cwd 并发枚举不漏降级、通配符/两级配置、能力边界、MCP deny（含迟到注册补偿与反复切换不卡死）、面板 RPC 全链路（鉴权栅栏逐请求生效、写盘即时生效、不存在的 cwd 直接拒绝且不写盘、并发写不丢更新、`default` 不被物化、损坏配置拒写、**跨层清除不假成功**——精确键在另一层时单条返回 `noop`、批量进 `skipped`，都不写盘）、面板在无 live agent 的工作区不借用别处目录、面板交互（状态下拉与「删除显式配置」、勾选与批量条、单行写盘后清空勾选、回执三种文案、分组表头）、三层排序、目录体量估算（`catalogChars` / `inCatalog` / `fallbackState`），以及 `catalog`/`policy` 的纯函数与缓存边界。

`test/integration-catalog.test.js` 在真实 0.2.0-rc.2 运行时上另锁五条**宿主发布语义**：首次发布是 `source.kind=skill-catalog` 的 durable user 消息（不带 update 标记）、目录未变时完全静默、目录变化时 update 带全量 entries 并**追加**为新消息、面板写盘后下一个 pre-step 立刻看到新目录、批量 `setSkills` 改 N 个技能**只追加一条** update。`test/integration.test.js` 另有一条锁**冷读**：`projects: []`（一个活动 agent 都没有）时用 host 全局实例 + preset scope 读目录，`off` 技能必须已被降级为 `userInvocable:false`（否则 `/` 菜单会列出它）。

## 许可

MIT
