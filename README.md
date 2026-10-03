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
| 设置 → **工作区能力** | 工作区选择、技能表格（名称/描述/来源/三态开关/可管理标记/正文体积/命中来源）、搜索、只看非默认项、默认状态、MCP 服务器开关（含"可见 x/y"核对）、当前项目根与配置来源 |
| 输入框右侧 **`/技能`** 按钮 | 搜索 + 点选 → 插入 `/技能名 ` 到输入框并回焦 |

面板的**状态列一律以本插件配置文件为准**，不拿注册表返回的 invocation 反推：冷读路径用的是 preset 作用域，看不到 agent 层的降级，会把 `manual`/`off` 显示成启用态。invocation 只作交叉核对——配置说"不该自动注入"而注册表仍显示可被模型调用时，该行会给一个"未生效?"标记。

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

## 能力边界（第一版）

只有**文件系统来源**的技能可被管理：`source` ∈ `project-dsh` / `project-agents` / `custom` / `user-dsh` / `user-agents`，且注册表给出了 `path`。

`bundled`（office/badge 等，正文在包内 assets）与 `runtime` 注册的技能在面板中标为"不可管理"并给出原因 —— 接管它们需要本插件在 `get()` 里复现正文，而正文来自包内 assets 或运行时拼接，做不到；强行接管会让 `/名` 静默失效。

**已知限制**：没有任何活动会话时（或会话未绑定 agent preset 时），面板的目录来自 preset 作用域，看不到 agent 层的降级，`/` 菜单里仍会出现 `off`/`manual` 技能（发送后手势路径才按配置生效）。面板会给出提示，并把该目录标为 `incomplete`。面板**只认与所选工作区 cwd 完全匹配的 agent**：工作区没有活动会话时不会借用别处的 agent 视图，而是回落到 preset / 全局并在面板上说明。

## 开发与测试

```bash
# 全部测试：纯 JS 单测 + 集成测试。缺解包运行时目录时，集成用例整体 skip，
# 所以新克隆直接 npm test 不会变红（输出里的 skipped 数会告诉你跳过了几条）。
npm test

# 只跑纯 JS 单测（无宿主依赖）—— test/config.test.js / rpc.test.js / client.test.js / render.test.js / catalog.test.js / policy.test.js / mcp.test.js / skills.test.js / index.test.js
npm run test:unit

# 只跑集成测试：在真实的 0.2.0-rc.2 运行时上跑
# 先从 App 包里解出运行时：<app.asar>/dsh → /tmp/dshref/runtime
DSH_RUNTIME_DIR=/tmp/dshref/runtime npm run test:integration

# 覆盖率（8 个 lib 文件，当前行 100% / 分支 ~90%）
node --test --experimental-test-coverage "test/**/*.test.js"
```

**覆盖率口径**：`lib/client.js` 的测试通过 `test/helpers/client-bundle.js` **每个进程只 import 一次**。早先用 `?t=<n>` 绕 ESM 缓存会让同一文件产生多个脚本实例，而覆盖率报告只保留其中一个，数字会被压低一半以上，补测试也看不出来。

**注意用 App 自带的 node**（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`，v24）：在系统 Node 上跑 **dsh 本体**、加载宿主原生模块时会报 `No usable native binding found for node-addon-require-builtin-darwin-arm64`。本插件的测试不触发该路径（实测系统 Node v25.9.0 全绿），但装插件、跑宿主仍请用 App 自带的 node。

覆盖范围：agent 层 shadow 赢过 preset 层的 filesystem provider、注册表 `invocation` 三态语义（`/名` 手势与 `skill` 工具的**实际**拒绝由运行时 `dsh-tool-skill` 保证，测试只断言注册表视图）、同 cwd 并发枚举不漏降级、通配符/两级配置、能力边界、MCP deny（含迟到注册补偿与反复切换不卡死）、面板 RPC 全链路（鉴权栅栏逐请求生效、写盘即时生效、不存在的 cwd 直接拒绝且不写盘、并发写不丢更新、`default` 不被物化、损坏配置拒写）、面板在无 live agent 的工作区不借用别处目录、以及 `catalog`/`policy` 的纯函数与缓存边界。

## 许可

MIT
