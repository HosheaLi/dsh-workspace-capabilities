# dsh-workspace-scope

按**工作区（项目目录）**决定技能是否进入模型目录，并屏蔽与本项目无关的 MCP 服务器 —— **工具 schema 与 server instructions 提示词段都屏蔽**。

一句话语义：把某个技能标成 `manual` 之后，**模型看不见它，但 `/技能名` 手动调用照样注入全文**。
常见的「覆盖型」技能插件选择彻底停用（`/名` 一起死掉），这一档是本插件的核心增量。

- 版本 `0.0.1`（迭代维护起点，变更见 [`CHANGELOG.md`](CHANGELOG.md)）
- 零运行时依赖：host 半边只用 node 内置模块，client 半边只依赖平台种子 `react`
- 宿主基线 `@deepseek-ai/*` 0.2.1-rc.2（2026-10-17 复核）

## 三种状态

| 状态 | 进 `<available_skills>` | `skill` 工具 | `/名` 手势 | 用途 |
| --- | --- | --- | --- | --- |
| `pinned`（默认） | ✅ | ✅ | ✅ | 本工作区常用技能，交给模型自选 |
| `manual` | ❌ | ❌ | ✅ | 「关闭自动注入」，靠面板点选或手打调用 |
| `off` | ❌ | ❌ | ❌ | 与本工作区完全无关 |

默认值是 `pinned`：装上插件不产生任何行为突变，再由你在工作区里把不需要的标掉。

## 配置

两级，项目级优先，键为技能名或通配符（`*` 任意长度、`?` 单字符）：

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
- **`mcp` 开关同时管两层**：`false` 既把该服务器的 `mcp__<server>__*` 工具从 agent 的
  schema 里 deny 掉，也在该 agent 作用域注册同名的空 `mcp:<server>` 提示词段，遮蔽
  `dsh-mcp-client` 在 host 层注册的 server instructions。两层都省 token，但**进程不会被停掉**
  —— MCP server 由 host 组合持有，与本插件无关。
- **匹配优先级**：精确名 > 通配符（多个命中取最长模式）> `default`。
- **`default` 只在显式设置过时才落盘**：缺省写一个默认值等于把它物化成显式配置，而项目层优先，
  于是「在项目里关掉一个技能」会顺带盖掉你全局设的 `manual`/`off`。
- **写盘**：`mkdir -p` → 写临时文件 → `rename`；读-改-写整条链在同一路径上串行；顶层未知键原样
  保留；文件存在但不是合法 JSON 时**拒绝写入并报错**，绝不拿空配置覆盖你手工修的内容。
- 面板只写**项目层**（没有项目层时才写全局层）。项目根等于 home 时跳过项目层，只读写全局配置
  —— 否则两级会变成同一个文件而静默互相覆盖。

路径分离与匹配算法的完整理由见 [`docs/architecture.md`](docs/architecture.md) 第 4 节。

## 界面

| 位置 | 内容 |
| --- | --- |
| 设置 → **工作区能力** | 工作区选择、技能表格（勾选框 / 名称 / 描述 / 状态下拉，按「可管理 + 来源」分组）、批量条、搜索、只看非默认项、默认状态、MCP 服务器开关（含「可见 x/y」核对）、当前项目根与配置来源、目录体量估算 |
| 输入框右侧 **`/技能`** 按钮 | 搜索 + 点选 → 插入 `/技能名 ` 到输入框并回焦 |

几个要点：

- **状态列是原生下拉**：自动注入 / 仅手动 / 关闭；该行有精确配置键时多一项「**删除显式配置
  （→ 回落态）**」——回落态由 host 按**写入层**算好，标注删掉这个键之后实际会落到哪一态。
  键在另一层时这一项不出现（删了不改变生效状态，host 返回 `noop` 而不是给个点了没反应的动作）。
- **勾选列 + 批量条**：表头勾选框作用于**当前筛选结果里的可管理行**；勾选集跨搜索/筛选保留，
  切换工作区与写盘成功后清空。批量走**一次**原子 RPC，逐条回报被跳过的行与原因。
- **排序三层**（面板与 `/技能` 浮层共用同一顺序）：可管理优先 → 来源（项目 `.dsh` → 项目
  `.agents` → 自定义 → 用户 `.dsh` → 用户 `.agents` → 包内置 → 运行时注册）→ 名称。前五个来源的
  顺序与官方 `dsh-skill-filesystem` 的优先级完全一致，所以**面板顺序 = 同名冲突时的真实优先级**。
- **面板显示的状态一律以本插件配置文件为准**，不拿注册表返回的 invocation 反推；两者不一致时
  该行会给一个「未生效?」标记。
- **描述与回执**：描述列 2 行截断（`title` 保留全文），来源标签贴在描述单元格末尾；不可管理行
  **也能看到自己的描述**，不可管理的原因挂在徽标 tooltip 上。写盘回执分三种，避免自相矛盾：
  `已改 N 项`（有跳过时追加 `；跳过 M 项：名字（原因）`）／`未做任何改动；跳过 M 项：…`／
  `所选技能已经是目标状态，未写盘`。
- 工具栏常驻目录体量估算（例如 `目录 ≈ 4.5k 字符 / 31 条`，字符数按宿主渲染规则估算，token 换算
  只在 tooltip 里），批量条给出本次动作的 Δ。

## 改配置对进行中的会话意味着什么

一句话：**立即生效，但每次目录变化都会在会话里永久追加一份完整目录 —— 所以批量改，别反复横跳。**

技能目录不是系统提示词的一部分，而是会话里一条普通的 durable **user 消息**，宿主在**每个模型步**
重算它的 digest：

| 你做了什么 | 会话里发生什么 |
| --- | --- |
| 写盘了但目录内容没变 | **完全静默**，零成本 |
| 目录内容变了 | **追加**一条带全量 `<available_skills>` 的替代消息（不是就地替换、不是差量） |
| 关掉某技能又打开 | 算**两次**变化 → 两次追加 |

- **成本**：改 k 次 ≈ 该会话永久多 k 份目录，每份都是全量。本机 31 条技能目录约 **4.5k 字符/份**
  （≈1.2k token，估算值），并打断一次前缀缓存（prompt cache）。
- **生效时机**：下一个模型步 —— **同一回合里继续调工具的那一步也算**；不需要重启 App、不需要
  重开会话（与「改 `cordis.patch.yml` 要重启」是两回事）。
- **`/` 候选菜单是另一条路**：菜单数据由客户端**按会话缓存**，只在切换 agent preset 或连接重置
  时失效。所以改完配置后，**已经打开过的会话**里的 `/` 菜单要等这次失效才刷新（新会话、重连后
  立即是新目录）；模型目录不受这个缓存影响，仍是下一个模型步生效。
- **不回收历史**：已经进过上下文的技能正文留在历史里，标成 `off` 只是让**以后**不再加载。
- **MCP 两层是另一条触发链**：工具 deny 与提示词段遮蔽都在 `tools/change`、会话内 `cd`
  （`working-directory/change`）、以及面板写盘（RPC 显式 invalidate）时重算。所以从面板改
  `mcp` 开关是立即生效的；**手改 JSON 文件**则要等下一次 `cd` 或 `tools/change` 才会被重新
  施加（策略缓存本身 1 秒过期，限制在"重算时机"而不是"读盘"）。

机制链路、探针实测数字与代码定位见 [`docs/architecture.md`](docs/architecture.md) 第 2 节；
要自己复核就跑探针：

```bash
DSH_RUNTIME_DIR=/tmp/dshref/runtime node tools/probe-skill-catalog-publish.mjs
```

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

在 profile 的 `package.json` 里把 `dsh-workspace-scope` 追加到 `dsh.profile.bundles`，随 profile
一起升级。

**两种方式都需要重启宿主进程**（host 与 client 半边都在启动时装配）。

## 能力边界

只有**文件系统来源**的技能可被管理：`source` ∈ `project-dsh` / `project-agents` / `custom` /
`user-dsh` / `user-agents`，且注册表给出了 `path`。

`bundled`（office/badge 等，正文在包内 assets）与 `runtime` 注册的技能在面板中标为「不可管理」
并给出原因 —— 接管它们需要复现正文，做不到；强行接管会让 `/名` 静默失效。

**MCP 层只省 token，不停进程**：`false` 的服务器仍由 host 组合照常启动并占用内存/启动时间；
被省掉的是工具 schema（`tools.restrict` deny）与 server instructions（agent 作用域同名空段遮蔽）。
要连进程一起省，只能把 MCP server 从 host 组合挪出去（例如放进一个专用 agent preset），
代价是它只在该 preset 的会话里可用。

**子 agent 同规则**：`subagent` / `subagent_fork` / 团队成员创建出的子 agent 与主会话共用同一套
工作区策略。子 agent 创建时会等 MCP 工具 deny 与 server instructions 遮蔽**落地后**才放行第一个
模型步，所以不会出现「主会话关了、子 agent 还能调」的抢跑；技能目录的降级在创建时同步注册，
也没有这个窗口。

**冷读路径**：没有任何活动会话时，面板与 `/` 菜单的目录来自 preset 作用域，本插件在 preset 层
同样注册了降级 provider，结论与 agent 读一致；面板会把该目录标为 `incomplete` 并说明来源。
面板**只认与所选工作区「同一项目根」的 agent**（会话 `cd` 到项目子目录不影响归属），不会借用
别处项目的目录展示。

**会话内切换目录（0.2.1 起）**：会话可以用 `working_directory` 工具 `cd`，此时
`session.header.cwd` 只是初始目录。本插件按**当前**目录求策略：技能降级跟随宿主的读取目录，
MCP 屏蔽在 `working-directory/change` 后重算。面板的**归属判定按项目根**：`cd` 到项目子目录不
产生新的工作区行、也不会丢失该会话的 agent 视图与 MCP 核对；跨项目 `cd` 才多出一行。
**写盘范围刻意不变**：仍是注册表工作区 ∪ 会话初始目录，`cd` 进入的新目录只可查看、不可写盘
（避免模型把插件配置写到任意目录）。旧宿主没有这个服务时静默回落到会话初始 cwd，行为不变。

## 开发与测试

```bash
npm test               # 154 用例：131 单测通过 + 23 集成（需运行时，默认跳过）
npm run test:unit      # 只跑纯 JS 单测（无宿主依赖）
npm run test:integration   # 只跑集成测试，需先在 /tmp/dshref/runtime 解包运行时
```

覆盖率（2026-10-18 实测）：**行 100.00% / 分支 ≈90%（实测 90.3–90.6，会抖）/ 函数 97.51%**。
测试入口、覆盖率口径与
波动说明、手工验收清单、维护检查清单见 [`docs/development.md`](docs/development.md)。

跑宿主请用 App 自带的 node（v24）；本插件的测试在系统 Node 上同样全绿。

## 文档地图

| 文档 | 面向 |
| --- | --- |
| [`README.md`](README.md) | 使用者：是什么、怎么配、装在哪 |
| [`docs/architecture.md`](docs/architecture.md) | 维护者：宿主机制事实、模块划分、实现要点、能力边界 |
| [`docs/development.md`](docs/development.md) | 维护者：环境、测试、覆盖率口径、探针、维护检查清单 |
| [`docs/archive/`](docs/archive/) | 历史：已实施完毕的开发方案原文，只读不改 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更记录 |
| [`tools/probe-skill-catalog-publish.mjs`](tools/probe-skill-catalog-publish.mjs) | 研究探针：复核宿主发布语义 |

## 许可

MIT，见 [`LICENSE`](LICENSE)。
