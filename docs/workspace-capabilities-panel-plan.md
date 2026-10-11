# 工作区能力面板 + 技能目录注入：优化方案

> 状态：**待评审（未实施）** · 2026-10-11 · 对象：`dsh-workspace-scope@0.1.0`
> 结论先行：三个问题里只有第 3 个是机制问题；而它的实测结论会反过来决定第 1 个怎么设计——
> **批量修改不是"顺手做的便利功能"，它是当前唯一能减少会话成本的手段。**

---

## 0. 结论摘要

| # | 你的问题 | 结论 | 改动落点 |
| --- | --- | --- | --- |
| 1 | 状态列改下拉框、前方加勾选框支持批量修改 | 可行。状态改 `<select>` 后单行省 ~110px，勾选框只占 24px，净腾出约 90px 全给描述列 | `lib/client.js`（列模板/行/工具条）+ `lib/rpc.js`（新增 `setSkills`） |
| 2 | 排序：先"是否可管理" → 再"技能来源" → 再名称 | 可行。"来源"列可同时并入技能单元格并由分组表头承载，再省 ~90px | `lib/catalog.js`（纯函数）+ `lib/rpc.js`（`state` 排序）+ `lib/client.js`（分组表头） |
| 3 | 中途改 skill，旧会话会加载吗？会不会多花 token？ | **会加载，从下一个模型步起生效**（无需重开会话、无需重启）。代价：**每一次目录变化都会在该会话里永久追加一份完整目录消息**（本机 31 条约 4.5k 字符），并且打断一次前缀缓存 | 面板加"生效时机 + 成本"提示与估算（`lib/rpc.js` + `lib/client.js`） |

---

## 1. 机制事实：技能目录是怎么进上下文的

这一节全部有代码定位或实测支撑，是第 3 问的答案，也是第 1 问设计依据。

### 1.1 目录不是系统提示词，是一条 **durable 用户消息**

链路（`@deepseek-ai/*` 0.2.0-rc.2，路径为解包运行时）：

1. `dsh-agent-loop/lib/index.js:951-957` —— 一个 turn 内**每个 step 循环**调用 `preStep()`（`step = phase.step + 1`），不是每轮对话一次。
2. `dsh-agent-loop/lib/index.js:902-918` —— `preStep()` 先 `inbox.claim()` 取这一步新输入，再 `systemPrompt.assemble()`，最后 `dispatch.waterfall('agent/pre-step', …)` 交给中间件链。
3. `dsh-tool-skill/lib/index.js:203-235` —— 该中间件在**每一个模型步**：`ctx.skills.snapshot({cwd, scope: agent})` → 过滤 `isModelInvocable` → 算条目 digest → 与"本会话最后一次发布的目录"比对。
4. digest 变了：首次发 `renderCatalogMessage`（`index.js:238`），之后发 `renderCatalogUpdate`（`index.js:262`）——后者是**带全量 `<available_skills>` 的替代声明**，文字是 "This complete catalog replaces every earlier available-skills list in this session"。
5. `dsh-agent-loop/lib/index.js:1061` —— 产生的消息以 `user/message` + `surfaceOp: 'append'` 写进会话。

所以：**目录是会话里的一条普通 user 消息**，不是系统提示词的一部分，也不是每轮重新渲染的临时块。

### 1.2 实测：4 次改动 = 会话里 4 份目录

探针（组合真实 `dsh-tools` / `dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill` + 本插件，复刻 `preStep` 的调用方式与 append 语义），3 个技能：

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
| `update` 消息是**追加**，不是就地替换（`catalogMessage()` 只扫描**这一步**的 claimed 消息，历史里的旧目录不在其中，`index.js:349`） | 会话里目录消息**只增不减**，每条都是全量。改 k 次 ≈ 永久多 k 份目录，直到压缩（compaction）动到它 |
| `update` 带**全量**条目，不是差量 | 小幅改动和大幅改动都追加一整份；31 条技能 ≈ 4.5k 字符/份 |
| digest 没变时**完全静默**（`index.js:222`） | 写盘但没有实质变化 → 零成本。反之"关掉又打开"= 两次完整追加 |
| 压缩把目录消息移出 surface 后，`catalogHistory()`（`index.js:331`）拿不到 `visibleDigest`，下一步会**重新追加一份完整目录** | 这是运行时的既定行为，插件无法阻止；只能让目录本身更小（此条为代码推断，未实测） |

本机现状量级：两处全局技能根共 30 个技能，本会话目录 31 条（含包内置 office 三件套），`<available_skills>` 条目合计 **4.46k 字符**；按 3.8 字符/token ≈ **1.2k token**，中文占比重时上限约 2.6k（估算，非精确 tokenizer 计数）。

### 1.3 改动什么时候生效

| 路径 | 生效时机 | 证据 |
| --- | --- | --- |
| 模型目录 `<available_skills>` | **下一个模型步**（同一回合内继续调工具的那一步也算） | 上面的实测：写盘后 step 3 立刻拿到新目录 |
| `skill` 工具 | 调用时现查注册表：`list()` → `isModelInvocable` → `get()` | `dsh-tool-skill/lib/index.js:138-160` |
| `/技能名` 手势 | 发消息那一步现查：`isUserInvocable` 为 false 则**静默跳过**，不注入正文 | `index.js:168-200`（`continue` 分支） |
| 面板写盘 → 目录缓存 | **无 TTL 延迟**：`writeLayer()` 里 `policy.invalidate()` + `notifyChanged()` → 注册表 `revision++` 清 `collectCache` | `lib/rpc.js:80-89`、`lib/index.js:94-106`、`dsh-skill/lib/index.js:265-280` |

**不需要重启 App、不需要重开会话**——与"改 `cordis.patch.yml` 要重启"是两回事。

### 1.4 不会发生的事（避免误判）

- 不会追溯撤回：已经注入过的技能正文（`skill` 工具结果、`/名` 注入的 `<skill_content>`）**留在历史里**，标成 `off` 只是让**以后**不再加载。
- 不会让模型"忘掉"旧名单：替代声明明确写了 "Use only names in this replacement catalog"，模型拿到的是权威新名单；旧消息里的失效名字按运行时规则作废。
- 不会影响其他会话的既有目录：每个会话各自持有自己的目录消息；改动只对"之后发生的模型步"生效。

---

## 2. 改动一：状态改下拉框 + 勾选框批量修改

### 2.1 列布局（一次性定稿）

现状（`lib/client.js:62`）：`minmax(145px,190px) minmax(126px,1fr) minmax(80px,116px) minmax(180px,212px)`，四项下限 + 间距 = 555px，描述列被挤到下限 126px 且只显示一行。

建议改为三项 + 勾选框：

```js
const GRID_COLUMNS = '24px minmax(140px, 180px) minmax(150px, 1fr) 88px';
const GRID_MIN_WIDTH = '426px';   // 24+140+150+88 + 3×8
```

| 列 | 内容 | 变化 |
| --- | --- | --- |
| 勾选框 24px | 行选择；不可管理行 disable + title 说明 | 新增 |
| 技能 `140-180px` | 第一行技能名；第二行 `来源 · 体积 · 显式配置/命中 xxx`（原"来源"列内容并入） | 合并 |
| 描述 `1fr` | 保留单行省略，**增加 2 行截断**（`-webkit-line-clamp: 2`）与 `title` 全文 | 变宽 |
| 状态 88px | 原生 `<select>`：自动注入 / 仅手动 / 关闭（+ 有精确键时追加"删除显式配置"一项） | 由 3 个按钮 + 清除按钮 → 1 个下拉 |

净效果：描述列在 555px 面板宽下拿到约 **240–280px**（原 126px），且可显示两行。

同时修一个现存小缺陷：`lib/client.js:558` 描述列渲染的是 `skill.reason ?? skill.description`，导致**不可管理技能永远看不到自己的描述**。改为：描述列恒显示 `description`；`reason` 变成"不可管理"徽标的 `title`；"未生效?"徽标同样挪到技能名旁（tooltip 文案不变）。

### 2.2 交互

- 表头勾选框：全选**当前筛选结果里的可管理行**；部分选中 → `indeterminate`。
- 行勾选框：不可管理行禁用（title：不可管理的原因）。
- 批量条（有选中时出现在工具条与表格之间，不选中时不占位）：

  ```text
  已选 3 / 共 31 项 ｜ 设为 [自动注入 ▾] [应用] ｜ [恢复默认] ｜ [清除选择]
  ```

  - `应用` = 一次 RPC 写盘（见 2.3）。
  - `恢复默认` = 删除显式键（只对"精确键命中"的行有效，通配符命中的行会被 host 跳过并在结果里回报）。
  - 切换工作区、筛选变化、写盘成功后清空选择（避免看不见的选中项被误批量修改）。
- `Shift+点击` 范围选择：P2 可选项，不做也不影响主流程。

### 2.3 host：新增 `setSkills`（批量、原子、一次写盘）

`lib/rpc.js` 方法表新增，与现有 `setSkill` 并列：

```js
/** 批量设置技能状态：N 个名字 → 1 次读-改-写、1 次缓存失效。 */
async setSkills(args) { … }
```

语义与约束：

1. 参数：`{ cwd, names: string[], state: 'pinned'|'manual'|'off'|'default', layer? }`。
2. 校验：`names` 必须是数组、元素非空字符串、去重、上限（建议 200）；`state` 必须在 `SKILL_STATES` 内；`cwd` 沿用 `requireScope` 的存在性校验。
3. **以当前目录为准核对**：先 `collectCatalog()`，对每个名字判定——
   - 目录里没有 → `skipped: '当前目录没有这个技能'`；
   - `manageabilityOf()` 不可管理 → `skipped: '不可管理：<原因>'`；
   - `state === 'default'` 且 `matchedKeyOf()` 命中的不是精确名 → `skipped: '命中的是通配符/默认，没有可清除的显式键'`。
4. **真无操作则根本不写盘**：所有候选行都满足 `matchedKey === name && 当前值 === 目标值` 时，直接返回 `{ noop: true }`。理由见 1.2：写盘本身不花钱，但"值变了"就会在会话里追加一份目录；防止手滑制造一次全量追加，也避免给项目层配置文件制造无意义的 git diff。
5. 写盘：`writeLayer(entry, layer, (config) => applied.reduce(...))`——复用 `withSkillState` / `withoutSkillState`，**只调用一次** `updateConfigFile`（内部串行链 + 原子 rename），失败时不产生中间态。
6. 返回：`{ layer, path, applied: string[], skipped: [{ name, reason }], noop?: true }`。面板据此显示"已改 5 项，跳过 2 项（原因）"。

**为什么必须批量**：N 次单条 `setSkill` = N 次读-改-写 + N 次 `invalidate()` + N 个中间状态。人点得快时它们会落在同一个模型步之间、被 digest 合并成一次目录更新；但只要恰好跨过一个模型步（agent 正在跑工具），就会变成多次全量追加。批量把这件事变成**确定的一次**。

### 2.4 测试

| 文件 | 用例 |
| --- | --- |
| `test/rpc.test.js` | `setSkills`：N 个名字只写盘一次（spy `updateConfigFile` 调用次数/文件内容）、原子性（一个 JSON 里同时出现 N 个键）、跳过不可管理/不存在/通配符清除、`state` 与 `names` 参数校验、`noop` 不写盘、`layer` 校验、`notifyChanged` 只触发一次 |
| `test/render.test.js` | 行内是 `<select>` 而非三个按钮；不可管理行 checkbox 禁用；表头 checkbox 的三态；批量条在选中时出现并发出 `setSkills`；`Shift` 选中（若实现）；应用后清空选择 |
| `test/catalog.test.js` | 若把"哪些行可批量清除"抽成纯函数（建议 `clearableKeysOf(effective, rows)`），单测它 |

### 2.5 备选与取舍

- 不用原生 `<select>` 而做自定义浮层：省 ~24px，但丢键盘/无障碍，且与面板既有的两个原生 `<select>`（工作区、默认状态）不一致 → 不采用。
- 保留行内"清除"独立按钮：占宽且与下拉重复 → 合并成下拉第 4 项。
- 不引入 `@deepseek-ai/dsh-client-ui-primitives`：需要新增 `dsh.client.external` 声明，绑定宿主版本；本插件现在 client 半边只依赖 `react`，这条边界值得守住。

---

## 3. 改动二：排序与分组

### 3.1 规则（三层，稳定全序）

1. **是否可管理**：`manageable === true` 在前。
2. **技能来源**：按"作用范围由近到远、非文件系统来源最后"：

   | 序 | source | 面板显示 | 与运行时 rank 的关系 |
   | --- | --- | --- | --- |
   | 0 | `project-dsh` | 项目 .dsh/skills | 100 |
   | 1 | `project-agents` | 项目 .agents/skills | 200 |
   | 2 | `custom` | 自定义目录 | 300 |
   | 3 | `user-dsh` | ~/.dsh/skills | 400 |
   | 4 | `user-agents` | ~/.agents/skills | 500 |
   | 5 | `bundled` | 包内置 | 600 |
   | 6 | `runtime` | 运行时注册 | 250 |
   | 7 | 未知/空 | 未知来源 | — |

   前五项与 `dsh-skill-filesystem` 的 `*_RANK` 完全一致（`lib/index.js:21-25`），所以面板顺序 = 同名冲突时的优先级顺序；`bundled`/`runtime` 排在最后，因为它们与本工作区的作用范围无关（且都不可管理，天然落进第二组）。
3. **技能名**：沿用现有 `localeCompare`。

### 3.2 落点

- `lib/catalog.js`：把 `SOURCE_LABELS` 改成由 `[source, label]` 有序数组派生，同时导出 `SOURCE_ORDER`、`sourceRankOf()`、`compareCatalogRows()`（纯函数，零依赖，便于单测）。
- `lib/rpc.js:137`：把 `rows.sort((l, r) => l.name.localeCompare(r.name))` 换成 `rows.sort(compareCatalogRows)`。**排序归 host**：`state` 已经是全量数据面，且 `/技能` 浮层共用同一份顺序。
- `lib/client.js`：`SkillTable` 渲染时按相邻行的 `(manageable, source)` 变化插入分组表头：

  ```text
  可管理 · 项目 .dsh/skills (3)
  ▸ [☐] skill-a   描述…        自动注入
  …
  不可管理 · 包内置 (3)
  ```

  分组表头顺带承担了原"来源"列的职责——这是敢把来源列并走的依据。空分组不渲染。

### 3.3 测试

- `test/catalog.test.js`：`compareCatalogRows` 的三层顺序、未知来源落最后、`SOURCE_ORDER` 与 `SOURCE_LABELS` 键集合一致（防止将来加来源时漏配显示名）。
- `test/rpc.test.js`：`state` 返回的 `skills` 顺序（可管理优先 → 来源 → 名称）。
- `test/render.test.js`：分组表头出现顺序与文案、空分组不出现、`GRID_COLUMNS`/`GRID_MIN_WIDTH` 常量断言（现有 286-294 行的用例改写）。

---

## 4. 改动三：把"半途修改"的代价摆到面板上

第 3 问的答案不能只写在文档里——使用者要在点下去之前就知道代价。

### 4.1 面板提示（必做）

1. 头部（`ScopeHeader`）加一行常驻说明：

   > 改动**立即生效**：本工作区的会话在**下一个模型步**就会用新目录（无需重启/重开）。每次目录变化会在每个受影响会话里追加一份完整目录。

2. 工具条统计行增加目录体量估算：

   ```text
   共 31 个技能：可管理 28（隐藏 12、关闭 5），不可管理 3 ｜ 目录 ≈ 4.5k 字符（≈ 1.2k token）
   ```

   算法（host 侧，`state` 里算一次）：`inCatalog(row) = row.invocation.modelInvocable && (row.manageable ? row.state === 'pinned' : true)`，字符数 = `Σ (name + description + 6)`（`- \`x\`: ` 与换行）。文案必须标"≈"，因为 tokenizer 与运行时 `catalogDescriptionMaxLength`（默认 500，可配置）都可能不同。
3. 批量条上显示改动方向：

   ```text
   选中 12 项：目录 ≈ 2.8k 字符（-1.7k）｜ 本次会在会话里追加 1 份新目录
   ```

   两个数字是两件事，分开写清楚：稳态目录变小是**每个后续请求**都受益；追加一份是**一次性**成本。

### 4.2 明确不做的事

- **不做"延迟到回合结束再生效"**：行为不可预测（点了没反应）、要跨 host 会话状态排队、失败语义复杂，收益仅是"少一次追加"；批量写盘已经消掉了绝大多数重复追加。
- **暂不做"运行中会话"警告**：`settings.section` 的标准 props 里有 `useSessionStatus`（`dsh-cordis-client-runner` 的 slot 契约），但快照形状未文档化（只有 `dsh-client-ui-conversation` 内部用法可参考）。要用就得先实测，收益有限，如要做归 P2。

---

## 5. 实施计划

三个阶段，**全部写在同一文件集上，必须串行**（`lib/client.js` 是共同写域）。每阶段一个原子提交。

| 阶段 | 内容 | 写域 | 验收 |
| --- | --- | --- | --- |
| **S1** | 列布局定稿 + 状态下拉 + 勾选框 + 批量条 + `setSkills` RPC + 描述列缺陷修复 | `lib/client.js`、`lib/rpc.js`、`test/render.test.js`、`test/rpc.test.js` | `npm run test:unit`；`DSH_RUNTIME_DIR=/tmp/dshref/runtime npm test` 全绿；覆盖率保持行 100% |
| **S2** | `compareCatalogRows` + `state` 排序 + 分组表头 | `lib/catalog.js`、`lib/rpc.js`、`lib/client.js`、`test/catalog.test.js`、`test/rpc.test.js`、`test/render.test.js` | 同上 + `compareCatalogRows` 单测 |
| **S3** | 生效时机提示 + 目录体量/Δ 估算 + 把探针固化成集成用例 | `lib/rpc.js`、`lib/client.js`、`test/integration.test.js`、`test/render.test.js` | 同上；集成用例断言"改配置后下一步追加一条全量 update 消息、无变化时静默" |
| **收尾** | README：界面表格更新 + 新增"改配置对进行中的会话意味着什么"一节；`Vault/20_Personal/Experience/开发工具与配置.md` 追加一条经验（现象→根因→解法→适用场景） | `README.md`、Vault | 文档与实现一致 |

**基线证据**：本次已解包运行时到 `/tmp/dshref/runtime`，`DSH_RUNTIME_DIR=/tmp/dshref/runtime npm test` → **87 passed / 0 failed / 0 skipped**。所有阶段的验收都在这个基线上比较。

**手工验收**（宿主与 client 半边都在启动时装配）：重启 App → 设置 → 工作区能力 → 勾选 3 个技能批量设 `仅手动` → 打开该工作区的一个会话发一条消息 → 目录消息应只出现一条 update、且不含这 3 个技能。

---

## 6. 待拍板

| # | 问题 | 我的建议 |
| --- | --- | --- |
| 1 | 布局：来源列并入技能单元格（描述列 ~240–280px），还是保留独立来源列（描述列 ~150–190px）？ | **并入**：来源由分组表头 + 单元格第二行双重承载，重复显示不值得 90px |
| 2 | 分组：始终显示分组表头，还是只排序不分组？ | **始终分组**：用户提的"分类"就是分组；如果只排序，来源列就不能并走 |
| 3 | 批量条要不要"恢复默认"（删除显式键）？ | **要**，但只对精确键生效，通配符命中的行明确回报"跳过了哪几个、为什么" |
| 4 | 现在就开工，还是先只做 S1+S2？ | 建议 **S1 → S2 → S3 一次做完**，S3 只是两处文案 + 一个估算函数，但它是第 3 问的落地 |
| 5 | 探针固化成集成用例（会引入 `dsh-tool-skill` / `dsh-llm` 依赖与一个 session 替身）是否值得？ | **值得**：它锁定的正是"反复改技能会让会话膨胀"这个非直觉事实，将来宿主升级改了这个语义，测试会先响 |

---

## 附：探针复现

```bash
# 解包运行时（一次性）：把 app.asar 内的 dsh/ 解到 /tmp/dshref/runtime
DSH_RUNTIME_DIR=/tmp/dshref/runtime node docs/probe-skill-catalog-publish.mjs
```

`docs/probe-skill-catalog-publish.mjs` 组合真实 `dsh-tools` / `dsh-skill` / `dsh-skill-filesystem` /
`dsh-tool-skill` + 本插件，用最小 session 替身（`seq` / `surface.nodes` / `eventAt` / `append`）
复刻 `dsh-agent-loop` 的 `preStep` 调用方式，打印每个模型步实际产生的目录消息。
它验证的是**宿主行为**、不属于 `npm test`；S3 会把它裁剪成集成用例（见第 5 节）。
