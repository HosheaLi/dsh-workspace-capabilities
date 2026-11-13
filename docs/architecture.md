# 架构与实现要点

> 面向维护者。使用者视角看仓库根 [`README.md`](../README.md)；开发与测试口径看 [`development.md`](development.md)。
> 宿主基线：`@deepseek-ai/*` **0.2.1-rc.2**（App 自带运行时，2026-10-17 复核）。第 2、3 节里依赖宿主内部结构的结论，
> 在宿主升级后必须重新验证（复核手段见 `development.md` 的「探针」一节）。其中两处是**未公开的私有
> 结构、失效时完全静默**，升级后要重点看：`skills.collectCache`（`lib/skills.js` 内层读的缓存丢弃）
> 与 `agentPresets.generations`（`lib/preset.js` 的 preset 层绑定）。

## 1. 模块划分

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：装配依赖、生命周期（agent 创建/销毁、`tools/change`、卸载收尾）、缓存失效编排 |
| `lib/policy.js` | 按 cwd 求生效策略：两级配置读取 + 1 秒 TTL 进程内缓存 + 代际（写盘后作废在途读） |
| `lib/config.js` | 路径解析、归一化、合并、精确/通配符匹配、原子串行写入 |
| `lib/catalog.js` | 目录枚举（三视图并集）、可管理性判定、正文读取、面板排序、目录体量估算 |
| `lib/cwd.js` | 当前目录与工作区归属：`effectiveCwdOf`（投影优先、回落 header）+ `scopeRootOf` / `agentScopeMatch`（按项目根判定） |
| `lib/skills.js` | **agent 层** shadow provider（三态降级的核心落点） |
| `lib/preset.js` | **preset 层** shadow provider 绑定（无活动 agent 的冷读路径） |
| `lib/mcp.js` | MCP 工具 deny 名单推导 + `tools.restrict` 施加器 |
| `lib/rpc.js` | 面板 RPC 方法表 + `webServer` exact 路由注册 + 逐请求鉴权栅栏 |
| `lib/client.js` | 浏览器半边：手写 bundle，提供设置页 `settings.section` 与输入框 `conversation.input.right` 两个 slot |

数据流：

```text
宿主每个模型步
  └─ dsh-tool-skill 中间件 → ctx.skills.list({cwd, scope: agent})
       └─ 注册表分层合并 → 命中本插件的 shadow provider（agent 层 / preset 层）
            ├─ 内层读：拿到未降级的全量目录（重入哨兵返回空候选的那次）
            ├─ policy.read(cwd) → 生效策略
            └─ 返回降级候选（manual/off）→ 跨过 pinned 的交给官方 provider

设置面板 / 输入框
  └─ POST /api/workspace-scope/rpc → rpc.js 方法表 → config.js 原子写
       └─ policy.invalidate() + notifyChanged() → 推到下一个模型步
```

## 2. 宿主机制事实：技能目录是怎么进上下文的

这一节的每条都有运行时代码定位或探针实测支撑（`tools/probe-skill-catalog-publish.mjs`）。

### 2.1 目录不是系统提示词，是一条 durable 用户消息

链路（`@deepseek-ai/*` 0.2.1-rc.2，路径为解包运行时）：

1. `dsh-agent-loop/lib/index.js:956-959` —— 一个 turn 内**每个 step 循环**调用 `preStep()`
   （`step = phase.step + 1`），不是每轮对话一次。
2. `dsh-agent-loop/lib/index.js:902-918` —— `preStep()` 先 `inbox.claim()` 取这一步新输入，
   再 `systemPrompt.assemble()`，最后 `dispatch.waterfall('agent/pre-step', …)` 交给中间件链。
3. `dsh-tool-skill/lib/index.js:931-963` —— 该中间件在**每一个模型步**：
   `ctx.skills.snapshot({cwd, scope: agent})` → 过滤 `isModelInvocable` → 算条目 digest →
   与「本会话最后一次发布的目录」比对。
   0.2.1 起这里的 `cwd` 来自 `ctx.workingDirectory.ensure(agent, signal)`，
   不再直接读 `session.header.cwd`（见 2.5）。
4. digest 变了：首次发 `renderCatalogMessage`（`index.js:966`），之后发 `renderCatalogUpdate`
   （`index.js:990`）—— 后者是**带全量 `<available_skills>` 的替代声明**，文字是
   "This complete catalog replaces every earlier available-skills list in this session"。
5. `dsh-agent-loop/lib/index.js:1069-1073` —— 产生的消息以 `user/message` + `surfaceOp: 'append'`
   写进会话。

结论：**目录是会话里的一条普通 user 消息**，不是系统提示词的一部分，也不是每轮重新渲染的临时块。

### 2.2 实测：4 次改动 = 会话里 4 份目录

探针（组合真实 `dsh-tools` / `dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill` + 本插件，
复刻 `preStep` 的调用方式与 append 语义），3 个技能：

```text
── step 1（首次） ──        发布形态：initial | 条目数: 3 | 目录字符数: 780
── step 2（无变化） ──      发布条数：0（静默）
── 面板改配置 beta-skill → off ──
── step 3（目录已变） ──    发布形态：update | 条目数: 2 | 目录字符数: 612
会话里的目录消息总数：2     消息序列：user → skill-catalog → skill-catalog
── 再来一次 alpha-skill → manual ──   累计目录消息：3
── 横跳回来 alpha-skill → pinned ──    累计目录消息：4
```

四条硬结论：

| 事实 | 含义 |
| --- | --- |
| `update` 消息是**追加**，不是就地替换（`catalogMessage()` 只扫描**这一步**的 claimed 消息，历史里的旧目录不在其中，`index.js:1077`） | 会话里目录消息**只增不减**，每条都是全量。改 k 次 ≈ 永久多 k 份目录，直到压缩（compaction）动到它 |
| `update` 带**全量**条目，不是差量 | 小幅改动和大幅改动都追加一整份；31 条技能 ≈ 4.5k 字符/份 |
| digest 没变时**完全静默**（`index.js:950`） | 写盘但没有实质变化 → 零成本。反之「关掉又打开」= 两次完整追加 |
| 压缩把目录消息移出 surface 后，`catalogHistory()`（`index.js:1059`）拿不到 `visibleDigest`，下一步会**重新追加一份完整目录** | 运行时既定行为，插件无法阻止；只能让目录本身更小（此条为代码推断，未实测） |

本机量级（2026-10-11）：两处全局技能根共 30 个技能，本会话目录 31 条（含包内置 office 三件套），
`<available_skills>` 条目合计 **4.46k 字符**；按英文 3.8 字符/token ≈ **1.2k token**，若目录里中文
占比重（口径见 `lib/client.js` 的 1.6 字符/token）则约 **2.8k token**。两种都是估算，不是精确
tokenizer 计数。

### 2.3 改动什么时候生效

| 路径 | 生效时机 | 证据 |
| --- | --- | --- |
| 模型目录 `<available_skills>` | **下一个模型步**（同一回合内继续调工具的那一步也算） | 2.2 的实测：写盘后 step 3 立刻拿到新目录 |
| `skill` 工具 | 调用时现查注册表：`list()` → `isModelInvocable` → `get()` | `dsh-tool-skill/lib/index.js:866-889` |
| `/技能名` 手势 | 发消息那一步现查：`isUserInvocable` 为 false 则**静默跳过**，不注入正文 | `index.js:900-931`（`continue` 分支） |
| 输入框 `/` 候选菜单 | 宿主 `SessionSkillCatalog.list`（没有活动 agent 时用 preset standing scope 冷读）→ **客户端按 sessionId 缓存**，只在切换 agent preset 或连接重置时失效 | `dsh-client-ui-skill/lib/client.js:367`（`fetches` Map）、`:408`（`invalidate`）、`:482`（`agent-preset/selected`）、`:484`（`connection/reset` → `clearAll`） |
| 面板写盘 → 目录缓存 | **无 TTL 延迟**：`writeLayer()` 里 `policy.invalidate()` + `notifyChanged()` → 注册表 `revision++`（`dsh-skill/lib/index.js:377`）使 `collectCache` 里按 revision 派生的键整体失效（同文件 `269-270`、`395-400`） | `lib/rpc.js:144-153`、`lib/index.js:114-129` |

**不需要重启 App、不需要重开会话** —— 与「改 `cordis.patch.yml` 要重启」是两回事。

唯一例外是**输入框的 `/` 候选菜单**：那份数据由客户端按 sessionId 缓存，改完配置不会主动失效，
要等切换 agent preset 或连接重置才刷新。所以「改动立即生效」对模型目录成立，对**已经打开过的
会话里的 `/` 菜单**不成立（新会话与重连后立即是新目录）。这正是本插件要在 preset 层再注册一份
provider 的原因 —— 否则被关掉的技能照样出现在菜单里，选中插入后又静默不注入。

### 2.4 不会发生的事（避免误判）

- **不会追溯撤回**：已经注入过的技能正文（`skill` 工具结果、`/名` 注入的 `<skill_content>`）
  留在历史里，标成 `off` 只是让**以后**不再加载。
- **不会让模型「忘掉」旧名单**：替代声明明确写了 "Use only names in this replacement catalog"，
  模型拿到的是权威新名单；旧消息里的失效名字按运行时规则作废。
- **不会影响其他会话的既有目录**：每个会话各自持有自己的目录消息；改动只对「之后发生的模型步」生效。

### 2.5 宿主 0.2.1 新增：会话内可切换工作目录（已适配）

0.2.1 起 `dsh-working-directory` 把「会话当前目录」做成独立投影，`dsh-tool-working-directory`
提供 `working_directory` 工具（`cd`）。宿主的技能读取因此统一改成
`ctx.workingDirectory.ensure(agent, signal)` 求 cwd（`dsh-tool-skill` 的 `inject` 也随之多了
`workingDirectory`，见 `dsh-tool-skill/lib/index.js:762-767`）——**技能的 cwd 跟随会话当前目录**，
`session.header.cwd` 只剩「创建时的初始目录」这一层含义。

本插件因此把「当前目录」与「工作区归属」都收敛到 `lib/cwd.js`：`effectiveCwdOf(ctx, agent)`
优先 `ctx.get('workingDirectory').get(session)`，取不到或抛错时回落 `session.header.cwd`
（旧宿主没有这个服务，行为与 0.2.0 完全一致）；`scopeRootOf()` 把它解析成**项目根**（与
`policy.read` 共用 `config.js` 的 `findProjectRoot`）；`agentScopeMatch()` 是「哪个 agent 属于
这个工作区」的唯一判定——按**项目根**比较，不是原始 cwd。四个调用点：

| 位置 | 用途 |
| --- | --- |
| `lib/index.js` `denyForAgent()` | MCP 屏蔽按当前目录的 `mcp` 配置算 deny 名单 |
| `lib/rpc.js` `listWorkspaces()` | 会话那一行用当前目录所属**项目根**（子目录 `cd` 不产生新行；注册表仍提供历史工作区） |
| `lib/rpc.js` 面板 MCP 探针 | 「同工作区」按项目根判定：子目录 `cd` 仍能匹配到会话，跨项目根不拿别处 agent 顶替 |
| `lib/catalog.js` `collectCatalog()` | agent 视图按项目根匹配、按 agent 的当前目录读取 |

重算时机：目录切换在会话里记为 `working-directory/change` 事件，插件监听
`ctx.on('session/event')`，按 session 对象身份找到 agent 后**先 `restrictor.noteChange()` 推进
代际、再 `apply`**（宿主在事件追加时 emit，`dsh-agent-loop/lib/index.js:319` 有同样用法）。
先推代际是必须的：`tools/change` 会并发地给所有 agent 各发一次 `apply`，在途那次 captured 的是
旧目录，而 `cd` 触发的这次会被施加器的重入哨兵直接返回——不推代际，在途结果落地后 deny 会停在
旧目录。技能目录不需要插件额外失效——宿主下一个模型步会用 `workingDirectory.ensure` 得到的
新 cwd 重新 `snapshot()`。

**读与写用两份清单**：可**查看** = 注册表 ∪ 活动会话当前目录所属项目根；可**写** = 注册表 ∪
活动会话**初始**目录所属项目根。`cd` 是模型可驱动的动作（`working_directory` 工具接受任意已
存在目录），它只扩大查看与生效策略的范围，不扩大插件的写入面——否则模型把目录切到哪里，面板
就能把 `.dsh/skills-scope.json` 写到哪里。因此 `cd` 进入的目录在面板里可以查看、可以据此核对
MCP 屏蔽，但写操作会被拒绝（提示去侧边栏登记工作区，或在该目录下开会话再写）。

注意：面板的「当前目录」与 DSH 侧边栏的「工作区」不是同一个概念。**归属判定单位是项目根**：
会话 `cd` 到项目子目录时项目根不变，面板不把它列成另一个工作区、也不因此丢失 agent 视图；
跨项目 `cd` 才会多出一行。会话在侧边栏的归属（`workspaceRegistry`）不因 `cd` 改变。

## 3. 实现要点

### 3.1 三态如何落到官方三条判定路径

`dsh-tool-skill` 的 `isModelInvocable` / `isUserInvocable` 是**分开**判的，所以三态能精确对应：

| 状态 | shadow provider 返回 | 效果 |
| --- | --- | --- |
| `pinned` | **不返回候选** | 官方 provider 继续供数，行为与未装插件完全一致 |
| `manual` | `{ modelInvocable:false, userInvocable:true }` | 不进 `<available_skills>`、`skill` 工具拒绝，但 `/名` 仍注入全文 |
| `off` | `{ modelInvocable:false, userInvocable:false }` | 不进目录，`/名` 也不注入 |

这是本插件的核心增量：市面上两个「覆盖型」技能插件都选择彻底停用（`/名` 一起死掉）。

### 3.2 两层 shadow provider，缺一不可

- **agent 层**（`agent.ctx.get('skills')`，不是属性访问）供模型目录与 `/名` 手势。
  技能注册表按层合并，`layers = [global, ...chainLayers(scope)]` 逐层覆盖，**近层直接赢、
  与 rank 无关**；注册到 host 全局层会被 preset 层静默盖掉，过滤完全不生效。
- **preset 层**（`preset.js`）供**没有活动 agent** 的冷读（输入框 `/` 菜单、面板目录）。
  宿主在注册 preset 定义时就 mount 了一份 standing 组合（与有没有 agent 无关），
  `generations` 是 registry 的运行时字段，`generation.scope.ctx` 就是那份组合的上下文、
  `scopeOf(它)` 正是冷读用的 `lease.key`。读不到这层结构时**安静退化**（保持 agent 层行为，
  只记一条 warn），启动期用有界重试（8 次 × 250ms）兜住「preset 定义注册晚于本插件 apply」
  的装配顺序。
- **同层内 rank 0 必胜**：官方文件系统根的 rank 是 100/200/300/400/500（项目 `.dsh` / 项目
  `.agents` / 自定义 / 用户 `.dsh` / 用户 `.agents`，见 `dsh-skill-filesystem/lib/index.js:20-24`），
  本地 bundled 根是 600（`dsh-skill/lib/index.js:23`），`compareIndexedCandidates` 按 rank 升序取
  先到者，所以同层里本插件的降级候选稳定赢过原候选。

没有 preset 层会怎样：`off` 的技能照样出现在 `/` 菜单里，用户选中插入后又**静默**不注入正文
—— 表现为「关了还能用斜杠调用」。

### 3.3 内层读的缓存必须丢掉

`list()` 内部要读「未降级的全量目录」，这次读会被注册表写进 `collectCache`。`layers` 是全局
共享的，但 `collectCache` **每实例一份**，而外层覆盖内层写入只发生在**同一个实例**上 ——
agent 读会经注册表调用 preset 层的 provider，那个内层读落在 **preset 实例**上，于是一份
「未降级目录」被缓存下来，之后的冷读命中它、降级就丢了（表现为「先读 agent、再读 `/` 菜单，
`off` 技能又出现了」）。

所以内层读返回后只删**本次新增**的缓存键（`skills.js` 的 `listWithoutCachingInnerResult`）：
删多了最坏是多扫一次目录，不会给出错误结果；`collectCache` 被并发调用换掉时直接跳过，
不碰别人的表。

### 3.4 重入哨兵判据是「同一条 async 调用链」

`list()` 内部要读注册表，会重新进入自己。内层调用返回空候选，外层拿到「未降级的全量目录」
构造降级候选；注册表在外层 collect 结束时用它覆盖内层写入的缓存。

判据是 **`AsyncLocalStorage`**（同一条 async 调用链），不是「同一个 cwd」：按 cwd 记名的集合
会把两个独立调用者的并发枚举也当成重入，让后来者拿到未降级目录、把 `manual`/`off` 技能重新
广告给模型。有单测锁住这条。

### 3.5 `get()` 自己读正文

赢家是自己，委托 `ctx.skills.get()` 会无限递归。正文按官方规则取（去 frontmatter 后
`body.trim()`），规则复刻在 `catalog.js` 的 `stripFrontmatter()`。

### 3.6 MCP `tools.restrict` 三段式防护 + 代际补偿

`restrict()` 会**同步** emit `tools/change`，无条件重注册会同步递归到栈溢出、卡死整个 dsh 进程。
防护是 ①哨兵（`applying` 集合）②deny 集合比较 ③先删记账再 dispose。

另有**代际补偿**：`computeDeny` 要读盘（async），await 期间可能又有工具注册进来；只在 await
前后比对 `generation`，变了就重算，避免「迟到注册的工具被漏 deny 且不报错」—— 这一条覆盖
「MCP 服务器重连后工具重新出现」。

工具名 → 服务器名**不靠反解第一段**：官方 `SERVER_NAME_PATTERN` 允许 serverName 含 `__`，
`mcp__my__server__tool` 会被解成 `my`，配置里的 `my__server` 匹配不上 → deny 名单为空 →
开关静默失效。所以优先用**已知服务器名**（配置的 `mcp` 段）做最长前缀匹配。

### 3.6.1 `agent/created` 必须等限制落地：子 agent 首个模型步不能抢跑

MCP 的 deny 名单与提示词遮蔽都要**读盘**（`policy.read`），而子 agent 的创建在
`agent/created`（`ctx.serial`）返回后**立刻进入第一个模型步**。早期实现是在监听器里
`void restrictor.apply(agent)` / `void syncPromptForAgent(agent)` 后立即返回，于是：

1. `tools.resolve()` 先于 deny 落地完成，子 agent 的首个请求拿到完整的 MCP 工具面；
2. `systemPrompt.assemble()` 先于空段注册完成，`mcp:<server>` server instructions 仍进提示词。

实测（本机 0.2.2-rc.2，`rea` 在工作区关闭）：修复前子 agent 首个 `request/header` 有
**306 个工具 / 234 个 `mcp__rea__*`**、提示词含 `### MCP server: rea`；修复后同一探针为
**72 个工具 / 0 个 rea 工具**、提示词无 `### MCP server: rea`。主会话一直是对的，所以
表现成「主会话关了、子 agent 还能调」。

修复两层：

- `agent/created` 监听器改为 **async 并 await** `Promise.all([restrictor.apply, syncPromptForAgent])`。
  宿主用 `ctx.serial` 派发该事件，会等待监听器返回的 Promise，子 agent 的创建因此被卡到
  限制落地之后。`bindAgent()` 与 `presetBinder.scan()` 仍是同步的，技能 shadow provider
  在第一个模型步之前就已就位（技能目录没有抢跑窗口）。
- `createMcpRestrictor().apply()` 返回**在途 Promise**，同一 agent 的并发调用共享同一份。
  只存布尔哨兵时，第二次调用会立刻返回，等待方会误以为「已经限制完」。`tools.restrict`
  同步 emit `tools/change` 引发的重入只是拿回同一个 Promise，不会死锁。
- deny 名单的工具表改从 **agent 作用域**的 `tools.schemas()` 读（不传 scope 仍是全局视图），
  不再访问插件 ctx 的 `ctx.tools`。HMR 重载时插件 fiber 可能尚未 active，`ctx.tools`
  会抛 `cannot get required service "tools" in inactive context`，使重载后的首次
  `apply` 失败、所有 agent 的限制静默丢失；用已经取到的 `scopedTools` 可绕过这个窗口。

**边界**：`tools/change` 与 `working-directory/change` 的补偿仍是 fire-and-forget
（事件派发不等待监听器）；它们对应的是「已经活着的 agent」，下一次模型步前通常已完成。
子 agent **创建**这条路径由 `agent/created` 的 serial 语义提供硬保证。

### 3.7 面板 RPC：注册可以早，鉴权必须逐请求做

`webServer` 的 exact 表优先于 Connection 的 `/api` prefix 表，而 `connection` 服务的就绪时机
晚于插件 apply —— 早注册会绕开官方那条已鉴权的 pipeline。所以两件事解耦：注册早（有 `webServer`
就注册，没有就等 `internal/service`），**每条请求过一遍** `connection.requestRejection`
（Host/Origin 反 DNS-rebinding + 浏览器会话 cookie / 进程 token）；它不在时才退化为
「回环 Host + 同源 Origin」的最小栅栏。无凭据 → 401，跨站 Origin → 403。

**退化栅栏的回环判定必须抄官方**：只认 `localhost`、`[::1]`，以及**四段十进制**且首段为 `127`
的 IPv4 字面量（`dsh-client-connection` 的 `isLoopbackHostname` 同款）。**不能用 `/^127\./`
前缀匹配** —— `127.0.0.1.evil.com`、`127.0.0.1.nip.io` 这类域名的 DNS 记录由攻击者控制，却能
通过前缀判定；页面从该域名加载即同源，而请求落到本机回环上，这正是 DNS rebinding。有单测锁住
这条（形如回环的域名一律 403，同时 127/8 的合法字面量仍放行）。

路由 handler 是 async，逃出去的异常会成为 unhandled rejection（Node 默认终止进程），
所以整个处理体自带兜底；方法检查放在构造 `Request` **之前**（`new Request(url, {method:'GET', body})`
直接抛 TypeError，一个走错的 GET 就能打崩宿主）。请求体上限 64 KiB，超了 413。

### 3.8 写盘：原子 + 串行 + 拒绝覆盖

- **原子**：`mkdir -p` → 写 `tmp-<pid>-<n>` → `rename`；失败清掉临时文件。
- **串行**：读-改-写整条链在同一路径的串行队列里（`writeChains`），两次快速点击不会互相覆盖。
  `ponytail:` 链按路径常驻不回收，路径数是工作区量级（个位），不值得做引用计数。
- **拒绝覆盖**：文件存在但不是合法 JSON 对象时**抛错拒写**，绝不拿空配置覆盖用户手工修的内容。
- **保留未知顶层键**：本插件只管 `version` / `default` / `skills` / `mcp`，其余原样带回。
- `apply` **必须同步**：Cordis 不把 `async apply` 返回的 Promise 当启动工作，其中抛错会成为
  unhandled rejection。所以入口用同步 `apply`，异步收尾一律 `.catch()`。

### 3.9 批量 `setSkills` 只落一次盘

N 个名字合成一次读-改-写（`withSkillState` / `withoutSkillState` reduce → 一次
`updateConfigFile`），并把「已经是目标值」的行排除出写集合。写盘本身不花钱，但**目录 digest
一变就会在每个受影响会话里追加一份完整目录**（第 2.2 节），所以批量是确定性收益：
N 次单条写一旦跨过模型步就会变成 N 份目录。

`state: 'default'`（删除显式键）的判据是「**目标写盘层里真有这个精确键**」，不是「合并后的
生效配置里有」。精确键在全局层、默认却写项目层时，按合并结果判断会回执成功并**凭空建出一个
空的项目层配置**，而生效状态一点没变 —— 这是开发期审查抓到的假成功。跨层键改到对应层去删。

## 4. 配置语义

### 4.1 两级、路径分离

| 层级 | 路径 | 用途 |
| --- | --- | --- |
| 项目 | `<项目根>/.dsh/skills-scope.json` | 随仓库提交，团队共享 |
| 全局 | `$DSH_HOME/settings/skills-scope.json` | 本机默认 |

项目根沿用 DSH 判定：最近的含 `.git` 的祖先目录；找不到则返回原始 cwd。

**路径刻意分离**：官方 `findProjectRoot` 在没有 `.git` 祖先时兜底返回原始 cwd，而 `~` 下没有
`.git`，所以在 home 目录里工作时「项目根」就是 home。若全局配置也放 `$DSH_HOME/` 根，两级会
变成同一个文件而静默互相覆盖。本模块两条防线：全局放 `settings/` 子目录；**项目根等于 home 时
跳过项目层**。

### 4.2 匹配优先级

精确名 > 通配符（多个命中取**最长模式**，长度相同按码点序取小以保证确定性）> `default`。
`skillStateOf` 与 `matchedKeyOf` 共用同一个 `bestGlobPatternOf`，避免「决定状态的模式」和
「面板显示的模式」各算各的。

### 4.3 `default` 只在显式设过时才落盘

缺省写一个默认值等于把它物化成显式配置，而项目层优先，于是「在项目里关掉一个技能」会顺带用
`pinned` 盖掉全局设的 `manual`/`off`，让本该不进模型目录的技能重新自动注入。

## 5. 能力边界（第一版）

只有**文件系统来源**的技能可被管理：`source` ∈ `project-dsh` / `project-agents` / `custom` /
`user-dsh` / `user-agents`，且注册表给出了 `path`。

`bundled`（office/badge 等，正文在包内 assets）与 `runtime` 注册的技能在面板中标为「不可管理」
并给出原因 —— 接管它们需要本插件在 `get()` 里复现正文，而正文来自包内 assets 或运行时拼接，
做不到；强行接管会让 `/名` 静默失效。

**冷读路径**：没有任何活动会话（或会话未绑定 agent preset）时，面板与 `/` 菜单的目录来自
preset 作用域。本插件在 preset 层同样注册了 shadow provider，那里的 `manual`/`off` 降级与
agent 读结论一致；面板仍会把该目录标为 `incomplete` 并说明来源。面板**只认与所选工作区属于
同一项目根的 agent**：工作区没有活动会话时不会借用别处项目的 agent 视图，而是回落到 preset /
全局并在面板上说明（借用会让 A 的技能挂在 B 名下、用 B 的配置渲染）。

**已知估算偏差**：`catalogCharsOf()` 复刻宿主渲染规则算字符数，但不做 `escapeText`
（`&`/`<`/`>` 变实体），描述里含这几个字符时会轻微低估；面板一律按「≈」展示。

**跨进程并发不在保护范围内**：同一 DSH home 只有一个宿主进程持有配置，写盘串行链是进程内的。

**写入路径的准入**：面板 RPC 的 `cwd` 必须同时满足两条 ——「真实存在且是目录」与「在**面板会
列出的工作区清单**里」（`workspaceRegistry` ∪ 活动会话的 cwd，与 `workspaces()` 同一数据源）。
只校验前者挡不住 `findProjectRoot` 的兜底行为：任何已存在的目录都会被当成项目根，于是本插件在
它下面 `mkdir -p` 出 `.dsh/` 并写一份配置 —— 一个它根本不管辖、面板也选不到的目录。清单与面板
同源，所以正常流程不受影响。

## 6. 有意不做的事

| 项 | 理由与升级条件 |
| --- | --- |
| 不拆 `lib/client.js`（1000+ 行，越过「文件 < 800 行」常规上限） | 拆包要引入构建链，而 client 半边刻意只依赖 `react` 这个平台种子。等到需要跨插件复用组件、或涨到 ~1500 行时再拆 |
| 不做「延迟到回合结束再生效」 | 行为不可预测（点了没反应）、要跨 host 会话状态排队、失败语义复杂；收益仅是少一次目录追加，而批量写盘已经消掉绝大多数重复追加 |
| 不做「运行中会话」警告 | `settings.section` 的 `useSessionStatus` 契约里快照形状未文档化，要用得先实测，收益有限 |
| 表头勾选框不做半选态 | `indeterminate` 是 DOM 属性、要 `ref` 才能设，本轮未做（不影响全选/取消全选） |
| 写盘串行链不做引用计数回收 | 路径数是工作区量级（个位）。见 `lib/config.js` 的 `ponytail:` 注释 |
