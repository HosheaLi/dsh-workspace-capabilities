# PLAN — 接下来的三个阶段

> 状态初值见 [`.planning/STATE.md`](../.planning/STATE.md)。这里是**计划**，不是已完成的事；
> 已完成的历史在 [`CHANGELOG.md`](../CHANGELOG.md)，已实施完毕的方案在 [`docs/archive/`](archive/)。
>
> 计划的来源只有两处，没有第三种：`docs/publishing.md`「当前状态」列出的剩余发布步骤、
> `docs/development.md`「维护检查清单」与 README 兼容性矩阵里明写的待补项。
> 每条判据都是可直接粘进终端跑的命令；判不了的地方标「人判」。

---

## 阶段 1：发布收尾（npm + tag）——已完成（2026-11-21）

**结果**：npm 包已上线并复核；`v0.1.0` tag 仍只在本地，这是有意为之。

- `dsh-workspace-capabilities@0.1.0` 于 2026-11-21 04:09:35 UTC 上线（首次 `npm publish` 04:07:28 只建了占位版）。
- `dist-tags.latest = 0.1.0`，`engines.dsh = >=0.2.1-rc.2 <0.3.0`；干净目录
  `npm i dsh-workspace-capabilities@0.1.0` 实测装上，`lib/` 的 11 个模块齐全。
- npm 的 staged publishing 会给新包先建 `0.0.0-stage` 占位（`stub: true`，2 文件 / 348 B），
  真实版本异步转正约 3 分钟；`npm view ... dist-tags` 仍指向占位时先等 3–5 分钟，别立刻重发。
- bypass-2FA token 的直接发布已被 npm 开始限制（`npm publish` 输出带 deprecation 链接），
  下个版本改用 trusted publishing 或 stage-only token + `npm stage approve`。
- **tag 仍只在本地**：推 tag 会触发 `release.yml` 再发一次 0.1.0，registry 拒绝覆盖版本、
  workflow 必红。所以「本地手动发布」与「CI tag 发布」只能二选一，当前走前者。

**判据**（保留，供下次发布核对）：

```bash
# npm 上能查到，且与 package.json 一致
[ "$(npm view dsh-workspace-capabilities version)" = "$(node -p "require('./package.json').version")" ] && echo "npm ok"

# 索引钉在已发布的提交上（需官方校验器，见 AGENTS.md）
node tools/check-market-index.mjs

# 本地门禁仍绿
bash scripts/verify.sh
```

**完成标志**：前两条打印 ok。tag 那条转到「是否切 CI 发布」时再单独判，不在本阶段范围。

---

## 阶段 2：让 23 条集成用例真正跑起来

**为什么**：`npm test` 现在是 149 通过 / 23 跳过，跳过的是**唯一能证明插件真的往宿主里生效**的那组（agent 层 shadow、preset 层绑定、MCP deny、面板 RPC 全链路、`cd` 跟随、宿主发布语义）。跳过原因是 `/tmp/dshref/runtime` 不存在。也就是说：单测全绿不等于插件在真实宿主上还能用，而这 23 条正是那道防线。

**要做的**：
1. 按 `docs/development.md`「解包运行时」把 App 内的 `dsh/` 解到 `/tmp/dshref/runtime`。
2. 跑集成测试，修暴露出来的问题（宿主版本已从 `0.2.1-rc.2` 走到 `0.2.2-rc.5`，两处私有结构是高风险点：`skills.collectCache`、`agentPresets.generations`）。
3. 决定是否把「解包 → 跑集成」写进 `scripts/verify.sh` 的可选步骤（现在不写：需要 App 安装路径，换机就断）。这一条**人判**。

**判据**：

```bash
test -d /tmp/dshref/runtime && echo "runtime ok"

DSH_RUNTIME_DIR=/tmp/dshref/runtime npm run test:integration

# 跳过数应为 0，失败数为 0
DSH_RUNTIME_DIR=/tmp/dshref/runtime npm test 2>&1 | grep -E "skipped|fail|pass"

bash scripts/verify.sh --no-coverage
```

**完成标志**：`DSH_RUNTIME_DIR=... npm test` 输出 `skipped 0` / `fail 0`，且 `docs/development.md` 的测试章节改成「集成默认跑」的口径。

---

## 阶段 3：Windows 实机复核 + 宿主升级适配

**为什么**：Windows 的路径 bug 是靠报告驱动的（`startsWith('/')` 那轮，见 `CHANGELOG.md` 0.1.0「修复」节）。修复后只有 CI 的 `windows-latest` 覆盖单测，**面板在 Windows 实机上是否真能用仍未被验证**——README 已如实写「Windows 开发中，近期更新」。这是当前唯一一个「代码看着对、实机没试过」的面。

**要做的**：
1. 在 Windows 11 + Desktop 上走一遍 `docs/development.md`「手工验收」五步，重点看路径相关的：面板能列出工作区（`C:\` 路径）、三态下拉能写盘、`cd` 到子目录后归属正确、面板标题不显示整条路径。
2. 顺手复核宿主私有结构：`skills.collectCache`（`lib/skills.js`）与 `agentPresets.generations`（`lib/preset.js`）在新宿主上是否还在；失效时**静默**，只能靠探针和集成测试抓。
3. 按复核结果更新 README「支持范围与兼容性」表（现在写的是「开发中，近期更新」；实机过了就改成「支持」，没过就保留并写清还剩什么）。

**判据**：

```bash
# 本机能自动判的部分：探针仍能复刻宿主发布语义
DSH_RUNTIME_DIR=/tmp/dshref/runtime node tools/probe-skill-catalog-publish.mjs

# 私有结构仍在（应各命中一处，输出为空说明被改名/删除）
grep -rn "collectCache" lib/skills.js
grep -rn "generations" lib/preset.js

# 文档口径已更新（应能搜到实机复核的结论，而不是"待补"）
grep -n "Windows" README.md
```

**人判**：Windows 实机那五步只能人工执行并留证据（截图或面板回执）。没有 Windows 机器时这个阶段**停在原地**，不要用 CI 绿代替实机结论。

---

## 不在计划里的事

- 不打算做：技能/MCP 的按会话（而非按工作区）粒度、远程同步配置、GUI 之外的第二套配置格式。这些是能力边界，不是欠账，理由见 `README.md`「能力边界」。
- 不打算重写 `lib/client.js` 的构建方式（手写 bundle 是刻意选择：零依赖、零构建，见 `AGENTS.md` 技术栈表）。
