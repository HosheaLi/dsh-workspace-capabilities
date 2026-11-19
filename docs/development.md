# 开发与测试

> 使用者文档看仓库根 [`README.md`](../README.md)；机制与实现要点看 [`architecture.md`](architecture.md)。

## 环境

- **Node ≥ 22**（`package.json` 的 `engines`）。无运行时依赖，`npm install` 不会装任何东西
  —— `node_modules/` 只有你手动软链进来的宿主包时才存在。
- 跑**宿主本身**（装插件、起 App）请用 App 自带的 node：
  `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`（v24）。
  在系统 Node 上加载宿主原生模块会报 `No usable native binding found for node-addon-require-builtin-darwin-arm64`。
  本插件的测试不触发该路径（2026-11-19 在系统 Node v26.13.0 上全绿）。
- **零 `@deepseek-ai/*` 依赖**：host 半边只用 node 内置模块，不随宿主版本漂移，因此也不需要
  peer 版本豁免。client 半边只 `require('react')` 这个平台种子。改动时请守住这条边界。

## 目录结构

```text
lib/                    host 半边（10 个模块，见 architecture.md 第 1 节）
lib/client.js           浏览器半边：手写 bundle（window.__ModuleLoader__.load）
test/                   纯 JS 单测 + 集成测试
test/helpers/           集成测试搭台（真实运行时 + 最小 session 替身）
tools/                  研究探针（不属于 npm test）
docs/                   正式文档（docs/images/ 为界面截图）
docs/archive/           已实施完毕的历史方案原文，只读不改
cordis.patch.yml        bundle patch：把 host 半边插进 profile 的 host 组合
```

## 测试

```bash
# 全部：163 用例 = 140 单测通过 + 23 集成跳过（缺运行时）
npm test

# 只跑纯 JS 单测（无宿主依赖）
npm run test:unit

# 只跑集成测试：在真实宿主运行时上跑（2026-11-19 基线 0.2.2-rc.5）
# 缺运行时（/tmp/dshref/runtime 不存在）时整体 skip，所以新克隆直接 npm test 不会变红
DSH_RUNTIME_DIR=/tmp/dshref/runtime npm run test:integration

# 覆盖率（CI 同款门禁：行 95% / 函数 90% / 分支 80%）
npm run test:coverage
```

**解包运行时**（一次性）：

```bash
# 把 App 包内的 dsh/ 解到 /tmp/dshref/runtime
npx asar extract "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" /tmp/dshref-extract
mkdir -p /tmp/dshref && mv /tmp/dshref-extract/dsh /tmp/dshref/runtime
```

`test/integration.test.js` 与 `test/integration-catalog.test.js` 默认读 `/tmp/dshref/runtime`，
可用 `DSH_RUNTIME_DIR` 覆盖；目录不存在时整组 skip（输出里的 `skipped` 数会告诉你跳过了几条）。

## 覆盖率口径

2026-11-19 实测（宿主 0.2.2-rc.5，单测 + 集成按缺运行时跳过）：

| 文件 | 行 | 分支 | 函数 |
| --- | --- | --- | --- |
| `catalog.js` | 100.00 | 90.43 | 100.00 |
| `client.js` | 98.75 | 82.31 | 90.63 |
| `config.js` | 100.00 | 90.30 | 96.67 |
| `cwd.js` | 100.00 | 100.00 | 100.00 |
| `index.js` | 96.80 | 85.37 | 85.00 |
| `mcp.js` | 100.00 | 96.61 | 100.00 |
| `policy.js` | 100.00 | 84.21 | 100.00 |
| `preset.js` | 100.00 | 94.44 | 100.00 |
| `prompt.js` | 97.04 | 86.11 | 100.00 |
| `rpc.js` | 100.00 | 90.60 | 100.00 |
| `skills.js` | 100.00 | 93.62 | 100.00 |
| **all** | **99.21** | **88.04** | **94.33** |

CI 门禁为**行 95% / 函数 90% / 分支 80%**。分支命中会随测试文件的执行时序小幅抖动，
判断退化看门禁与具体未覆盖行，不追小数第二位。

两条口径约束，改动测试前先读：

1. **`lib/client.js` 的测试必须每个进程只 import 一次**，走 `test/helpers/client-bundle.js`。
   早先用 `?t=<n>` 绕 ESM 缓存会让同一文件产生多个脚本实例，而覆盖率报告只保留其中一个，
   数字会被压低一半以上，补测试也看不出来。
2. **分支覆盖会小幅浮动**：`config.js` / `cwd.js` / `mcp.js` / `rpc.js` 里有依赖时序的分支。
   判断退化看 CI 门禁（95/90/80）与具体未覆盖行，不追小数第二位。

## 集成测试锁住什么

`test/integration.test.js` 在真实运行时上验证插件的端到端行为：agent 层 shadow 赢过 preset 层的
filesystem provider、preset 层绑定（scope 探测、幂等、retired/重建回收、有界重试、卸载取消、
结构畸形与注册冲突时安静退化）、内层读的缓存丢弃（跨实例污染、并发换表时不误伤）、冷读路径
（**没有活动 agent** 时 preset 作用域也按工作区策略降级，且与 agent 读结论一致）、同 cwd 并发
枚举不漏降级、MCP deny（含迟到注册补偿与反复切换不卡死）、面板 RPC 全链路（鉴权栅栏逐请求
生效、写盘即时生效、不存在的 cwd 直接拒绝且不写盘、**不在工作区清单里的 cwd 同样拒绝且不在
那里建 `.dsh/`**、并发写不丢更新、`default` 不被物化、损坏配置拒写、**跨层清除不假成功**）、
面板在无 live agent 的工作区不借用别处目录、**会话内 `cd` 后技能目录按当前目录读且 MCP 屏蔽
重新计算**（面板工作区清单与 MCP 探针同步跟随，**项目内子目录 `cd` 仍按项目根归属、不产生新的
工作区行**，`cd` 进入的新目录只可查看不可写盘）。

`test/integration-catalog.test.js` 另锁五条**宿主发布语义**（见 `architecture.md` 2.2）：

1. 首次发布是 `source.kind=skill-catalog` 的 durable user 消息（不带 update 标记）；
2. 目录未变时完全静默；
3. 目录变化时 update 带全量 entries 并**追加**为新消息；
4. 面板写盘后下一个 pre-step 立刻看到新目录；
5. 批量 `setSkills` 改 N 个技能**只追加一条** update。

宿主升级后这几条最先应该响 —— 它们锁的正是「反复改技能会让会话膨胀」这个非直觉事实。

搭台细节：0.2.1 起 `dsh-tool-skill` 的 `inject` 多了 `workingDirectory`，集成 harness 与探针
都给了一个最小替身（`ensure(agent) => agent.session.header.cwd`）。**宿主再新增 inject 服务时，
这两处也要补** —— 缺服务不会报错，只会让宿主插件不装配，目录用例表现为「0 条发布」，
看起来像本插件回归。

## 探针

`tools/probe-skill-catalog-publish.mjs` 是研究探针，**不属于 `npm test`**（它验证的是宿主行为，
不是本插件行为）。用途是复核 `architecture.md` 第 2 节的实测结论，宿主升级后重跑一次：

```bash
DSH_RUNTIME_DIR=/tmp/dshref/runtime node tools/probe-skill-catalog-publish.mjs
```

它组合真实 `dsh-tools` / `dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill` + 本插件，
用最小 session 替身（`seq` / `surface.nodes` / `eventAt` / `append`）复刻 `dsh-agent-loop` 的
`preStep` 调用方式，打印每个模型步实际产生的目录消息。

## 手工验收

宿主与 client 半边**都在启动时装配**，改代码后必须重启 App：

1. 重启 App → 设置 → 工作区能力；
2. 勾选 3 个技能 → 批量设为「仅手动」→ 应用；
3. 打开该工作区的一个会话发一条消息；
4. 会话里应只出现**一条** update 目录消息，且不含这 3 个技能；
5. （0.2.1+）在会话里让模型用 `working_directory` 工具 `cd` 到另一个项目目录：MCP 开关与
   技能可见性应按新目录生效，面板工作区列表应出现新目录（原目录仍在侧边栏工作区里）。

## 维护检查清单

改完准备提交前：

- [ ] `npm test` 全绿（140 passed / 23 skipped，缺运行时属于预期）
- [ ] `npm run test:coverage` 通过（行 ≥95% / 函数 ≥90% / 分支 ≥80%）
- [ ] 新增/修改的行为有对应用例（非平凡逻辑走 RED → GREEN，不写 fixture 框架）
- [ ] 没引入 `@deepseek-ai/*` 运行时依赖（`package.json` 的 `dependencies` 必须为空）
- [ ] 若升级了宿主：重跑 `tools/probe-skill-catalog-publish.mjs`，并重点确认两处**未公开私有结构**
      仍存在 —— `skills.collectCache`（内层读缓存丢弃）与 `agentPresets.generations`（preset 层
      绑定）；两者失效时是**静默**退化的。同时按新运行时复核 `architecture.md` 里的宿主行号
      与 `dsh-tool-skill` 的 `inject` 列表（缺服务时 harness 要补替身）
- [ ] `git diff` 里没有密钥、token、本机绝对路径里的真实用户名
- [ ] 文档与实现同步：`README.md`（使用者）/ `architecture.md`（机制）/ `development.md`（本文件）
- [ ] 用户可见的变化追加到 `CHANGELOG.md`
