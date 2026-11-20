# AGENTS.md — dsh-workspace-capabilities

> 项目专属事实与红线。通用纪律（提交、凭据、中文、审查分级等）在 `~/.dsh/AGENTS.md`，不在此复述。
> 使用者文档看 `README.md`；机制看 `docs/architecture.md`；测试口径看 `docs/development.md`。

## 这是什么

一个 DeepSeek Harness 插件（market 名 `dsh-workspace-capabilities`，插件行 id 仍是 `workspace-scope`，仓库目录叫 `D03_dsh-workspace-scope`）：按**工作区（项目目录）**决定技能是否进入模型目录、哪些 MCP 服务器的工具 schema 与 server instructions 被隐藏。三态语义 `pinned` / `manual` / `off`，其中 `manual` 是核心增量——模型看不见，但 `/技能名` 手动调用仍注入全文。

## 技术栈与版本

| 项 | 事实 |
| --- | --- |
| 语言/模块 | 纯 JavaScript ESM（`package.json` `"type": "module"`），无 TypeScript、无构建产物 |
| Node | `engines.node >= 22`；**本机 v26.13.0 上 `npm test` 全绿**（2026-11-20 实测） |
| 跑宿主用的 Node | App 自带 v24：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`。用系统 Node 加载宿主原生模块会报 `No usable native binding found for node-addon-require-builtin-darwin-arm64` |
| 宿主 | `engines.dsh: >=0.2.1-rc.2 <0.3.0`；桌面端实测基线 `0.2.2-rc.5`（`README.md:21`） |
| 运行时依赖 | **零**。`package.json` 无 `dependencies` / `devDependencies`，`npm install` 不装任何东西，`node_modules/` 只在你手动软链宿主包时才存在 |
| client 半边 | 手写浏览器 bundle `lib/client.js`（`window.__ModuleLoader__.load`），**只能** `require('react')` 这个平台种子 |
| host 半边 | 10 个模块，只用 node 内置模块 |

## 命令

```bash
bash scripts/verify.sh          # 唯一验证入口：语法自检 + 测试 + 覆盖率门禁（新增，见下）
bash scripts/verify.sh --no-coverage   # 省 2 秒，不等价 CI
bash scripts/wrapup.sh          # 收尾检查：git status + 建议提交信息 + 提醒更新 STATE（只打印）
bash scripts/wrapup.sh --commit # 同上，并直接做一次**本地**提交（不 push；敏感信息命中会拒绝）

npm test                        # node --test "test/**/*.test.js"，172 用例
npm run test:unit               # 纯 JS 单测，149 用例，无宿主依赖
DSH_RUNTIME_DIR=/tmp/dshref/runtime npm run test:integration   # 23 条集成用例，缺运行时整组 skip
npm run test:coverage           # CI 同款门禁：行 95 / 函数 90 / 分支 80
npm run build:index             # 重新生成市场索引（钉当前 HEAD 的 commit）
npm run check:index             # 需外部校验器，见下
```

- **没装任何依赖**：本仓库零运行时依赖，`scripts/verify.sh` 也不会 `npm install`。
- `npm run check:index` 依赖官方校验器 `@deepseek-ai/dsh-plugin-market-index`，它**不在** `dependencies` 里。装了才跑，否则 `scripts/verify.sh` 打印跳过原因、不计失败。装法：`docs/publishing.md`「发布步骤」第 5 步。
- **本机安装方式**：`~/.dsh/profiles/desktop/node_modules/dsh-workspace-capabilities -> 本仓库`（软链），并在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `insert: id: workspace-scope`。宿主 `hmr.root` 也含本仓库路径。
- **手工验收**：配置与 client 半边**都在启动时装配**，改完必须重启 App → 设置 → 工作区能力。步骤见 `docs/development.md`「手工验收」。

## 目录职责

| 路径 | 职责 | 可改性 |
| --- | --- | --- |
| `lib/` | host 半边 10 个模块（`index/config/policy/rpc/skills/mcp/preset/prompt/catalog/cwd`） | 改，需同步测试 |
| `lib/client.js` | 浏览器半边手写 bundle，直出发布产物 | 改，注意每进程只 import 一次（见坑 4） |
| `test/` | `*.test.js` 单测 + 两条集成测试 | 改 |
| `test/helpers/` | 集成搭台（真实运行时 + 最小 session 替身）。**不在 `npm test` 范围内** | 改 |
| `tools/` | 研究探针与索引脚本，**不属于 `npm test`** | 改 |
| `docs/` | 正式文档 | 改 |
| `docs/archive/` | 已实施完毕的历史方案原文 | **只读不改** |
| `docs/images/` | 界面截图，被 README 引用 | 只增 |
| `locale/` | `zh.json` / `en.json` 面板文案 | 改 |
| `cordis.patch.yml` | bundle patch：把 host 半边插进 profile 的 host 组合 | 谨慎 |
| `index.json` | 市场 format 1 索引，**钉 commit** | 用 `npm run build:index` 生成，别手改 |
| `.dsh/skills-scope.json` | 本仓库自身作为工作区的**真实配置**（dogfood） | 见红线 5 |
| `.github/workflows/` | `ci.yml`（Ubuntu+Windows 跑 `npm test`，覆盖率门禁只在 Ubuntu）、`release.yml`（`v*` tag 触发 npm 发布） | 谨慎 |
| `scripts/` | `verify.sh`（唯一验证入口）、`wrapup.sh`（收尾 + `--commit` 本地提交） | 改 |
| `.planning/STATE.md` | 进度 / 决策 / 阻塞三栏，**每轮结束更新** | 改 |
| `docs/PLAN.md` | 接下来三个阶段 + 每阶段判据命令 | 改 |
| `AGENTS.md` | 本文件：事实与红线 | 改 |

## 红线（不能动）

1. **零运行时依赖**：`package.json` 的 `dependencies` 必须保持为空；host 半边不得 import 任何 `@deepseek-ai/*`，client 半边不得 require 除 `react` 以外的包。理由：不随宿主版本漂移，不需要 peer 版本豁免。
2. **`workspace-scope` 这个 id 不能改**：client slot id 与插件行 id 都叫 `workspace-scope`，profiles 里的 id 覆盖依赖它；npm 上另一个独立实现 `dsh-workspace-scope`（Ri0n72Y 维护）注册了同一个 client slot id，**两者不能同装**（`README.md:17`）。
3. **`docs/archive/` 只读**：归档方案的原文，行号已漂移，只在头部标注，不回头改正文。
4. **覆盖率脚本里的 `--test-coverage-exclude="test/**"` 不能删**（`package.json` `test:coverage`，依据 `docs/development.md:86`）。删了 CI 会稳定误报，见坑 3。
5. **`.dsh/skills-scope.json` 是真配置不是夹具**：它控制的是本机打开本仓库时的技能可见性（当前有 8 个技能 `off`）。测试要用配置请自己在 tmp 目录造，别读它。
6. **不把面板写盘面扩大**：写盘范围刻意限定为「注册表工作区 ∪ 会话初始目录」，`cd` 进入的新目录只可查看、不可写盘。改成可写等于让模型往任意目录写插件配置。
7. **`index.json` 的 commit 钉法**：每次版本都钉在发布代码那个 commit 上，不钉 `main`。发布代码后要重跑 `npm run build:index`。
8. **提交策略（2026-11-20 起）**：每轮工作完成后**自动做本地提交**，中文 Conventional Commits，只到本地、**不 push**。提交前必须满足两条：`bash scripts/verify.sh` 跑过且通过（没跑就没有证据，不能提交）、`git diff --cached` 里没有密钥与本机私有路径。多个逻辑变化拆成多个提交，不把文档、脚本、源码混成一锅；`bash scripts/wrapup.sh --commit` 可以代劳机械部分，但它是兜底，不是免检。

## 踩过的坑（每条带证据）

1. **Windows 上面板完全不可用**（不是显示问题）。`lib/rpc.js` 曾用 `cwd.startsWith('/')` 判绝对路径，真实 `C:\...` 一律被拒，`state` / `setSkill` / `setSkills` / `setDefault` / `setMcp` 全部返回「cwd 必须是非空的绝对路径」。现改用 `node:path` 的 `isAbsolute` + `resolve` 归一。证据：`CHANGELOG.md` 0.1.0「修复」节第一、二条；`lib/rpc.js` 现有 `pathKey` 归一与 `test/cwd.test.js`。
2. **UTF-8 BOM 会让整份配置静默失效**。PowerShell 5.1 与「记事本另存为 UTF-8」都给文件加 BOM，`JSON.parse` 直接抛错 → 配置降级为空 → 技能静默回到目录。读写两侧都先剥 `\uFEFF`。证据：`CHANGELOG.md` 0.1.0「修复」节 BOM 条。
3. **覆盖率分母在 Node 22 与 26 之间不同**。Node 22 默认把测试文件本身算进 `all files`，Node 26 不算：同一份代码 CI 报 88% 行、本机报 99%，门禁稳定误报。所以脚本显式带 `--test-coverage-exclude="test/**"`。证据：`docs/development.md:86-90`。
4. **`lib/client.js` 的测试每个进程只能 import 一次**，走 `test/helpers/client-bundle.js`。早先用 `?t=<n>` 绕 ESM 缓存会让同一文件产生多个脚本实例，而覆盖率报告只保留其中一个，数字被压低一半以上、补测试也看不出。证据：`docs/development.md:92-94`。
5. **分支覆盖会小幅抖动**：`config.js` / `cwd.js` / `mcp.js` / `rpc.js` 里有依赖时序的分支。判断退化看门禁（95/90/80）与具体未覆盖行，不追小数第二位。
6. **裸 `node --test` 的用例数不可比**：默认发现规则会把 `test/helpers/*.js` 也当测试文件，比 `npm test` 多 3 条「通过」。`npm test` 才是准绳。证据：`docs/development.md:47`；2026-11-20 实测 175（152+23）对 172（149+23）。
7. **宿主两处私有结构失效时完全静默**：`skills.collectCache`（内层读缓存丢弃，`lib/skills.js`）与 `agentPresets.generations`（preset 层绑定，`lib/preset.js`）。宿主升级后最先要查这两处，失效不会报错、只会给出过期结论。证据：`docs/architecture.md:7-8`、`docs/development.md:159`。
8. **改代码后不重启 App 等于没改**：host 半边与 client 半边都在启动时装配一次；切换安装来源（源码 `link:` ↔ Git 固定版本）后同样必须重启，Loader 持有首次装配解析到的绝对路径，`install_bundle` 返回 `applied` 也可能继续跑旧代码。证据：`README.md:234-235`、`docs/development.md`「手工验收」。
9. **`npm run check:index` 会因缺包直接失败**：`tools/check-market-index.mjs` 顶层 `import('@deepseek-ai/dsh-plugin-market-index')`，本仓库零依赖，没装就 `ERR_MODULE_NOT_FOUND`（2026-11-20 实测）。它是发布检查，不是 `npm test` 的一部分。
10. **索引 commit 落后于 HEAD 是提示不是错误**：`check-market-index.mjs:43` 只 `console.warn`。发新版本前记得重跑 `build:index`。

## 文档偏差记录

**2026-11-20 已修复**（本轮校准，勿回退）：

- 用例数 `163（140 通过 / 23 跳过）` → **`172（149 通过 / 23 跳过）`**：`README.md`、`README.en.md`、`docs/architecture.md:5`、`docs/development.md`（三处）。
- `docs/development.md` 的覆盖率表按当日实测重测：all **99.23 / 88.28 / 94.22**。
- `CHANGELOG.md` 的 0.1.0 条目保留历史数字，并补一句 2026-11-20 的复核结论（不覆盖已发布的记录）。
- README / README.en 的**支持范围**改为如实的「仅 macOS，Windows 开发中」，并写入 CI 实测结果（`02dcb5a`，run 44555345566，两个作业 success）。

其余已核对一致：`lib/` 模块数、`npm test` 与裸 `node --test` 的 3 条差异、四种安装方式、发布状态（npm 404、origin 无 tag）。

**仍未验证、不要写成结论**：CI 只验证到 `02dcb5a`；Windows 面板无实机证据；Web 无实机证据；`docs/architecture.md` 的宿主行号未逐条复核。
