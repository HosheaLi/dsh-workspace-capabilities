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

**状态列是原生下拉**：自动注入 / 仅手动 / 关闭；该行有精确配置键（`matchedKey === name`）时多一项「**删除显式配置（→ 回落态）**」——回落态由 host 算好，标注删掉这个键之后实际会落到哪一态；不可管理行整列禁用。

**最左是勾选列 + 批量条**：表头勾选框 = 全选 / 取消全选**当前筛选结果里的可管理行**（一个可管理行都没有时禁用），不可管理行的勾选框禁用（title 写原因）。勾选集**跨搜索/筛选保留**，但切换工作区与写盘成功后清空——避免"看不见的选中项"被批量改掉。批量条只在有选中项时出现：

```text
已选 3 项（当前筛选 31 项） 设为 [自动注入 ▾] [应用] [恢复默认] [清除选择] ｜ 本次：目录 -1.7k 字符 ｜ 目录变化会在会话里追加 1 份完整目录
```

批量走**一次**原子 RPC `setSkills({ cwd, names, state })`——N 个名字一次读-改-写、一次缓存失效（为什么要批量见下节：N 次单条写盘一旦跨过模型步，就会变成 N 份目录）。不可管理、当前目录里不存在、`default` 却没有可清除精确键的行会被跳过并**逐条回报原因**，已经是目标值的行直接略过；全部都没变化时返回 `noop` 且**根本不写盘**。写盘后回执形如「已改 N 项；跳过 M 项：名字（原因）」，no-op 时是「所选技能已经是目标状态，未写盘」。

**描述列 2 行截断**（`-webkit-line-clamp: 2`，`title` 保留全文）——腾出的宽度来自状态列（3 个按钮 + 清除按钮 → 1 个下拉）；**来源不再单占一列**，作为描述单元格末尾的标签（`flex: 0 0 auto`，不参与压缩）并由分组表头共同承担。技能单元格第二行则是 `显式配置 · 1.2 KB` 这样的元信息（配置命中方式 + 正文体积）。**不可管理行也能看到自己的描述**：以前描述列渲染的是 `reason`，把描述顶掉了；现在 `reason` 挂在"不可管理"徽标的 tooltip 上，"未生效?"徽标同在技能名旁。

**排序三层**（`compareCatalogRows`，在 host 侧排好，面板与 `/技能` 浮层共用同一顺序）：可管理优先 → 来源（`project-dsh` → `project-agents` → `custom` → `user-dsh` → `user-agents` → `bundled` → `runtime`，未知/空来源最后）→ 名称。前五个来源的顺序与 `dsh-skill-filesystem` 的 `*_RANK` 完全一致，所以**面板顺序 = 同名冲突时的真实优先级**；表格按 `(可管理, 来源)` 插入分组表头（如 `可管理 · 项目 .dsh/skills（3）`），空分组不渲染。

面板的**状态列一律以本插件配置文件为准**，不拿注册表返回的 invocation 反推：冷读路径用的是 preset 作用域，看不到 agent 层的降级，会把 `manual`/`off` 显示成启用态。invocation 只作交叉核对——配置说"不该自动注入"而注册表仍显示可被模型调用时，该行会给一个"未生效?"标记。

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
- **shadow provider 注册在 agent 层**（`agent.ctx.get('skills')`，不是属性访问）。技能注册表按层合并，`layers = [global, ...chainLayers(scope)]` 逐层覆盖，**近层直接赢、与 rank 无关**；注册到 host 全局层会被 preset 层静默盖掉，过滤完全不生效。rank 取 0 只是同层内的保险。
- **重入哨兵**：`list()` 内部要读注册表，会重新进入自己。内层调用返回空候选，外层拿到"未降级的全量目录"构造降级候选；注册表在外层 collect 结束时用它覆盖内层写入的缓存。判据是**同一条 async 调用链**（`AsyncLocalStorage`），不是"同一个 cwd"：按 cwd 记名的集合会把两个独立调用者的并发枚举也当成重入，让后来者拿到未降级目录、把 `manual`/`off` 技能重新广告给模型。
- **`get()` 自己读正文**：赢家是自己，委托 `ctx.skills.get()` 会无限递归。正文按官方规则取（去 frontmatter 后 `body.trim()`）。
- **`tools.restrict` 三段式防护**：restrict 会**同步** emit `tools/change`，无条件重注册会同步递归到栈溢出、卡死整个 dsh 进程。防护是 ①哨兵 ②deny 集合比较 ③先删记账再 dispose。另有**代际补偿**：读盘期间若又有工具注册进来，重算而不是被哨兵静静吞掉 —— 这一条覆盖"MCP 服务器重连后工具重新出现"。
- **面板 RPC 逐请求过栅栏**：`webServer` 的 exact 表优先于 Connection 的 `/api` prefix 表，而 `connection` 服务的就绪时机晚于插件 apply。所以注册可以早、**鉴权必须逐请求做**，优先复用官方 `connection.requestRejection`（Host/Origin 反 DNS-rebinding + 浏览器会话 cookie/进程 token），它不在时才退化为"回环 Host + 同源 Origin"。无凭据 → 401，跨站 Origin → 403。
- **批量写盘只落一次盘**：`setSkills` 把 N 个名字合成一次读-改-写（`withSkillState` / `withoutSkillState` reduce → 一次 `updateConfigFile`，内部按路径串行 + 原子 rename），并把"已经是目标值"的行排除出写集合——写盘本身不花钱，但目录 digest 一变就会在每个受影响会话里追加一份完整目录；全部无变化时连文件都不碰。

## 能力边界（第一版）

只有**文件系统来源**的技能可被管理：`source` ∈ `project-dsh` / `project-agents` / `custom` / `user-dsh` / `user-agents`，且注册表给出了 `path`。

`bundled`（office/badge 等，正文在包内 assets）与 `runtime` 注册的技能在面板中标为"不可管理"并给出原因 —— 接管它们需要本插件在 `get()` 里复现正文，而正文来自包内 assets 或运行时拼接，做不到；强行接管会让 `/名` 静默失效。

**已知限制**：没有任何活动会话时（或会话未绑定 agent preset 时），面板的目录来自 preset 作用域，看不到 agent 层的降级，`/` 菜单里仍会出现 `off`/`manual` 技能（发送后手势路径才按配置生效）。面板会给出提示，并把该目录标为 `incomplete`。面板**只认与所选工作区 cwd 完全匹配的 agent**：工作区没有活动会话时不会借用别处的 agent 视图，而是回落到 preset / 全局并在面板上说明。

## 开发与测试

```bash
# 全部测试：纯 JS 单测 + 集成测试（当前 103 passed / 0 skipped）。缺解包运行时目录时，
# 集成用例整体 skip，所以新克隆直接 npm test 不会变红（输出里的 skipped 数会告诉你跳过了几条）。
npm test

# 只跑纯 JS 单测（无宿主依赖）—— test/config.test.js / rpc.test.js / client.test.js / render.test.js / catalog.test.js / policy.test.js / mcp.test.js / skills.test.js / index.test.js
npm run test:unit

# 集成测试在真实的 0.2.0-rc.2 运行时上跑。先从 App 包里解出运行时：<app.asar>/dsh → /tmp/dshref/runtime
# 注意 test:integration 只跑 test/integration.test.js（插件装配）；目录发布语义在 test/integration-catalog.test.js，
# 两个都跑用下面这条（npm test 也会带上它们）。
DSH_RUNTIME_DIR=/tmp/dshref/runtime node --test test/integration.test.js test/integration-catalog.test.js

# 覆盖率（8 个 lib 文件，当前行 100.00% / 分支 90.10% / 函数 97.12%）
DSH_RUNTIME_DIR=/tmp/dshref/runtime node --test --experimental-test-coverage "test/**/*.test.js"
```

**覆盖率口径**：`lib/client.js` 的测试通过 `test/helpers/client-bundle.js` **每个进程只 import 一次**。早先用 `?t=<n>` 绕 ESM 缓存会让同一文件产生多个脚本实例，而覆盖率报告只保留其中一个，数字会被压低一半以上，补测试也看不出来。

**分支覆盖会小幅浮动**：复跑实测在 89.9–90.1 之间，波动来自既有 `config.js` / `mcp.js` 里依赖时序的分支命中与否（行覆盖稳定 100.00%），与技能面板这轮改动无关。

**注意用 App 自带的 node**（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`，v24）：在系统 Node 上跑 **dsh 本体**、加载宿主原生模块时会报 `No usable native binding found for node-addon-require-builtin-darwin-arm64`。本插件的测试不触发该路径（实测系统 Node v25.9.0 全绿），但装插件、跑宿主仍请用 App 自带的 node。

覆盖范围：agent 层 shadow 赢过 preset 层的 filesystem provider、注册表 `invocation` 三态语义（`/名` 手势与 `skill` 工具的**实际**拒绝由运行时 `dsh-tool-skill` 保证，测试只断言注册表视图）、同 cwd 并发枚举不漏降级、通配符/两级配置、能力边界、MCP deny（含迟到注册补偿与反复切换不卡死）、面板 RPC 全链路（鉴权栅栏逐请求生效、写盘即时生效、不存在的 cwd 直接拒绝且不写盘、并发写不丢更新、`default` 不被物化、损坏配置拒写）、面板在无 live agent 的工作区不借用别处目录、面板交互（状态下拉与「删除显式配置」、勾选与批量条、回执文案、分组表头）、三层排序、目录体量估算（`catalogChars` / `inCatalog` / `fallbackState`），以及 `catalog`/`policy` 的纯函数与缓存边界。

`test/integration-catalog.test.js` 在真实 0.2.0-rc.2 运行时上另锁五条**宿主发布语义**：首次发布是 `source.kind=skill-catalog` 的 durable user 消息（不带 update 标记）、目录未变时完全静默、目录变化时 update 带全量 entries 并**追加**为新消息、面板写盘后下一个 pre-step 立刻看到新目录、批量 `setSkills` 改 N 个技能**只追加一条** update。

## 许可

MIT
