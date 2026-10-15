# 开发与测试

> 使用者文档看仓库根 [`README.md`](../README.md)；机制与实现要点看 [`architecture.md`](architecture.md)。

## 环境

- **Node ≥ 22**（`package.json` 的 `engines`）。无运行时依赖，`npm install` 不会装任何东西
  —— `node_modules/` 只有你手动软链进来的宿主包时才存在。
- 跑**宿主本身**（装插件、起 App）请用 App 自带的 node：
  `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`（v24）。
  在系统 Node 上加载宿主原生模块会报 `No usable native binding found for node-addon-require-builtin-darwin-arm64`。
  本插件的测试不触发该路径（实测系统 Node v25.9.0 全绿）。
- **零 `@deepseek-ai/*` 依赖**：host 半边只用 node 内置模块，不随宿主版本漂移，因此也不需要
  peer 版本豁免。client 半边只 `require('react')` 这个平台种子。改动时请守住这条边界。

## 目录结构

```text
lib/                    host 半边（9 个模块，见 architecture.md 第 1 节）
lib/client.js           浏览器半边：手写 bundle（window.__ModuleLoader__.load）
test/                   纯 JS 单测 + 集成测试
test/helpers/           集成测试搭台（真实运行时 + 最小 session 替身）
tools/                  研究探针（不属于 npm test）
docs/                   正式文档
docs/archive/           已实施完毕的历史方案原文，只读不改
cordis.patch.yml        bundle patch：把 host 半边插进 profile 的 host 组合
```

## 测试

```bash
# 全部：108 单测 + 22 集成 = 130 passed / 0 failed / 0 skipped
npm test

# 只跑纯 JS 单测（无宿主依赖）
npm run test:unit

# 只跑集成测试：在真实 0.2.0-rc.2 运行时上跑
# 缺运行时（/tmp/dshref/runtime 不存在）时整体 skip，所以新克隆直接 npm test 不会变红
DSH_RUNTIME_DIR=/tmp/dshref/runtime npm run test:integration

# 覆盖率（9 个 lib 文件）
DSH_RUNTIME_DIR=/tmp/dshref/runtime node --test --experimental-test-coverage "test/**/*.test.js"
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

2026-10-15 实测（`0.0.1` 基线）：**行 100.00% / 分支 89.90% / 函数 97.45%**。

| 文件 | 行 | 分支 | 函数 |
| --- | --- | --- | --- |
| `catalog.js` | 100.00 | 90.43 | 100.00 |
| `client.js` | 100.00 | 84.33 | 94.68 |
| `config.js` | 100.00 | 91.43 | 96.67 |
| `index.js` | 100.00 | 90.00 | 100.00 |
| `mcp.js` | 100.00 | 95.00 | 100.00 |
| `policy.js` | 100.00 | 90.00 | 100.00 |
| `preset.js` | 100.00 | 96.61 | 100.00 |
| `rpc.js` | 100.00 | 92.27 | 100.00 |
| `skills.js` | 100.00 | 95.83 | 100.00 |
| **all** | **100.00** | **89.90** | **97.45** |

两条口径约束，改动测试前先读：

1. **`lib/client.js` 的测试必须每个进程只 import 一次**，走 `test/helpers/client-bundle.js`。
   早先用 `?t=<n>` 绕 ESM 缓存会让同一文件产生多个脚本实例，而覆盖率报告只保留其中一个，
   数字会被压低一半以上，补测试也看不出来。
2. **分支覆盖会小幅浮动**：加 preset 层**之前**复跑 13 次实测 89.44%（11 次）/ 89.34%（1 次）/
   89.24%（1 次）；加上 preset 层之后单次实测 89.90%。波动来自既有 `config.js` / `mcp.js` 里
   依赖时序的分支命中与否（**行覆盖稳定 100.00%**），与面板那轮改动无关。判断分支覆盖是否退化，
   看的是「行覆盖是否仍 100%」而不是小数第二位。

## 集成测试锁住什么

`test/integration.test.js` 在真实运行时上验证插件的端到端行为：agent 层 shadow 赢过 preset 层的
filesystem provider、preset 层绑定（scope 探测、幂等、retired/重建回收、有界重试、卸载取消、
结构畸形与注册冲突时安静退化）、内层读的缓存丢弃（跨实例污染、并发换表时不误伤）、冷读路径
（**没有活动 agent** 时 preset 作用域也按工作区策略降级，且与 agent 读结论一致）、同 cwd 并发
枚举不漏降级、MCP deny（含迟到注册补偿与反复切换不卡死）、面板 RPC 全链路（鉴权栅栏逐请求
生效、写盘即时生效、不存在的 cwd 直接拒绝且不写盘、**不在工作区清单里的 cwd 同样拒绝且不在
那里建 `.dsh/`**、并发写不丢更新、`default` 不被物化、损坏配置拒写、**跨层清除不假成功**）、
面板在无 live agent 的工作区不借用别处目录。

`test/integration-catalog.test.js` 另锁五条**宿主发布语义**（见 `architecture.md` 2.2）：

1. 首次发布是 `source.kind=skill-catalog` 的 durable user 消息（不带 update 标记）；
2. 目录未变时完全静默；
3. 目录变化时 update 带全量 entries 并**追加**为新消息；
4. 面板写盘后下一个 pre-step 立刻看到新目录；
5. 批量 `setSkills` 改 N 个技能**只追加一条** update。

宿主升级后这几条最先应该响 —— 它们锁的正是「反复改技能会让会话膨胀」这个非直觉事实。

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
4. 会话里应只出现**一条** update 目录消息，且不含这 3 个技能。

## 维护检查清单

改完准备提交前：

- [ ] `npm test` 全绿（130 passed / 0 skipped）
- [ ] 覆盖率**行**仍是 100.00%
- [ ] 新增/修改的行为有对应用例（非平凡逻辑走 RED → GREEN，不写 fixture 框架）
- [ ] 没引入 `@deepseek-ai/*` 运行时依赖（`package.json` 的 `dependencies` 必须为空）
- [ ] 若升级了宿主：重跑 `tools/probe-skill-catalog-publish.mjs`，并重点确认两处**未公开私有结构**
      仍存在 —— `skills.collectCache`（内层读缓存丢弃）与 `agentPresets.generations`（preset 层
      绑定）；两者失效时是**静默**退化的
- [ ] `git diff` 里没有密钥、token、本机绝对路径里的真实用户名
- [ ] 文档与实现同步：`README.md`（使用者）/ `architecture.md`（机制）/ `development.md`（本文件）
- [ ] 用户可见的变化追加到 `CHANGELOG.md`
