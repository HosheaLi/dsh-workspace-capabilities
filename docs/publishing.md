# 发布到 DSH 插件市场

> 核对时间：2026-11-19（2026-11-20 复核了发布状态与 CI 结果），宿主 `0.2.2-rc.5`。DSH 的插件分发是「包 + 索引」，没有中心化上传后台；
> 官方在 2026-11-05 才宣布筹建官方插件市场，当前版本里能用的只有实验性的自定义索引。

## 机制

一个插件市场 = 一个静态托管的 JSON 索引（`format: 1`）+ 可安装的包。索引里每条记录写清
包名、展示元数据和一个**精确版本**的安装源：

- npm：`name@version`
- git：`git+<repo>.git#<40 位 commit>`（包在子目录时加 `&path:/<dir>`）

DSH 不校验索引里的声明，只校验格式；安装时仍走正常的插件安装与兼容性检查。

用户侧路径：**设置 → 插件 → 实验性插件 → 开启 Custom plugin indexes → 发现 → 添加索引源**，
然后浏览、搜索、安装。DSH 不内置任何索引源。

官方参考：

- [Plugin indexes](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)
- 索引校验器：[`@deepseek-ai/dsh-plugin-market-index`](https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-market-index)
- 官方索引生成器：`apps/plugin-market-generator`（从 npm 包名 / Git 仓库清单生成）

## 当前状态（2026-11-20 复核）

仓库已公开（`https://github.com/HosheaLi/dsh-workspace-capabilities`），索引地址实测返回 200，
所以「从索引安装」与「本地源码安装」可用。npm 上仍没有 `dsh-workspace-capabilities`
（`npm view` 404），`v0.1.0` tag 也还没推 —— npm 一行安装与 Git 固定版本安装都还不可用。
剩下的发布步骤：

1. 配置 `NPM_TOKEN`（见「仓库自动化」）；没有它时 tag 触发的 release 会在 publish 步失败；
2. 推 `v0.1.0` tag，让 release workflow 发 npm 并建 GitHub Release；
3. npm 发布后，README 首屏的状态块与 npm 徽章即可去掉「待发布」口径。

不想动 CI secrets 也行：在本地手动 `npm publish`，步骤见下一节。**两条路只能走一条**
（见该节末尾的「为什么不能既手动发布又推 tag」）。

## 本项目采用的方案

自建索引，放在本仓库根目录：

| 文件 | 作用 |
| --- | --- |
| `index.json` | format 1 索引，`source.type = git`，钉住发布 commit |
| `icon.svg` | 索引相对图标（相对 `index.json` 解析） |
| `tools/build-market-index.mjs` | 从 `package.json` + git HEAD 生成 / 追加版本 |
| `tools/check-market-index.mjs` | 用官方 `parseMarketIndex` 校验索引 |

索引地址（GitHub 仓库公开后可用）：

```text
https://cdn.jsdelivr.net/gh/HosheaLi/dsh-workspace-capabilities@main/index.json
```

jsDelivr 读 `main` 分支，CDN 快、不受 GitHub raw 15 秒超时影响；代价是它有缓存，发新版本后
索引可能滞后（可用 `https://purge.jsdelivr.net/gh/HosheaLi/dsh-workspace-capabilities@main/index.json`
主动刷新）。实测 purge 后各边缘节点收敛并不同步（同一时刻 `cdn` 还是旧内容、`gcore` 已是新内容），
所以**装完要核对依赖里的 commit**：`index.json` 钉的是哪个 commit，profile 的依赖就应该是哪个；
对不上就再 purge 一次或先改用 `raw.githubusercontent.com` 的地址。GitHub Pages 也可以，但要在仓库设置里开启；GitHub raw 在部分网络下会撞上 DSH 的
15 秒抓取预算。

## 发布步骤

1. 改 `package.json` 的 `version`，补 `CHANGELOG.md`。
2. 跑 `npm test` 与 `npm run test:coverage`，确认全绿。
3. 提交代码并打 tag：`git tag v0.1.0`。
4. 生成索引（会钉在当前 HEAD 上）：

   ```bash
   npm run build:index
   ```

5. 校验索引：

   ```bash
   npm install --prefix /tmp/dsh-market-check @deepseek-ai/dsh-plugin-market-index
   DSH_MARKET_INDEX_MODULE=/tmp/dsh-market-check/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js \
     npm run check:index
   ```

6. 提交 `index.json`，推送仓库与 tag。
7. 用 `curl` 确认索引 URL 返回 200 且是刚生成的 JSON；在 DSH 里添加索引源，实际安装一次。
8. 重点验证 client 半边真的注册成功：设置页应出现「工作区能力」。`client.js` 的
   `window.__ModuleLoader__.load({ id })` 必须与包名一致，否则会报
   `loaded without registering "<包名>" via __ModuleLoader__._load`。

> `index.json` 不能钉住「包含它自己的那次提交」——先提交代码并打 tag，再生成索引、单独提交。
> 索引里的 commit 指向代码提交即可，索引文件本身晚一个提交没有影响。

## 手动 npm 发布（不依赖 CI，逐步可抄）

> 前提：npm 账号对 `dsh-workspace-capabilities` 这个名字有发布权。名字目前未被占用
> （`npm view dsh-workspace-capabilities version` 返回 404，2026-11-20 复核）。同为 `dsh-workspace-scope`
> 的那个包是 Ri0n72Y 的独立实现，别用旧名发。

### 0. 前置检查

```bash
cd ~/code/D03_dsh-workspace-scope
node -v                                        # 需要 >= 22（engines.node）
npm whoami                                     # 没登录就先 npm login（浏览器/一次性密码）
npm view dsh-workspace-capabilities version    # 期望 404：名字还没被占
git status --short                             # 期望为空：发布前工作区必须干净
```

### 1. 定版本与变更记录

`package.json` 的 `version` 已是 `0.1.0`。要换号时用（不要用它顺手打 tag，tag 是第 5 步的事）：

```bash
npm version patch --no-git-tag-version     # 或 minor / major，或手改 package.json
```

同步在 `CHANGELOG.md` 顶部加 `## [x.y.z] - YYYY-MM-DD` 小节。**两者必须一致**：
`release.yml` 会拿 tag 和 `package.json` 比对，不一致直接失败。

### 2. 门禁

```bash
bash scripts/verify.sh        # 语法自检 + npm test + 覆盖率门禁（行 95 / 函数 90 / 分支 80）
```

`npm publish` 本身还会因为 `prepublishOnly` 再跑一遍 `npm test`，但这不替代覆盖率门禁。

### 3. 打包预演（看清楚要发什么）

```bash
npm pack --dry-run
```

应只包含 `package.json` 的 `files` 白名单：`lib/`（含手写 bundle `client.js`）、`cordis.patch.yml`、
`locale/`、`docs/`、`icon.svg`、`README.md`、`README.en.md`、`CHANGELOG.md`、`LICENSE`。
**出现 `.dsh/`、`test/`、`tools/`、`.git*`、任何 `.env` / 凭据文件就是有问题**，先停下改 `files`。

### 4. 发布

```bash
npm publish --access public
# 开了 2FA 的账号要在同一行带一次性密码：
npm publish --access public --otp=123456
```

不要加 `--provenance`：它要 CI 的 OIDC 身份，本地发布会报 provenance 相关的错。
`--access public` 对无 scope 的包是幂等的，写上是为了不和以后可能的 scoped 包混淆。

### 5. 复核发布结果

```bash
npm view dsh-workspace-capabilities version            # 应等于 package.json 的 version
npm view dsh-workspace-capabilities dist-tags.latest   # latest 指向同一版本
npm view dsh-workspace-capabilities engines.dsh        # >=0.2.1-rc.2 <0.3.0
npm view dsh-workspace-capabilities time.modified       # 刚刚
curl -s "https://registry.npmjs.org/dsh-workspace-capabilities" | head -c 200   # 能取到 tarball
```

**更好的复核是让别人装一次**：`npm i -g dsh` 后用 npm 一行安装路径装插件，确认设置页出现
「工作区能力」。npm 发布成功不等于 DSH 能装上，`engines.dsh` 不匹配会被宿主拒。

### 6. 发布后收尾（索引必须钉到发布的那次提交）

```bash
npm run build:index            # 把 index.json 钉在当前 HEAD 的 commit 上
git add index.json && git commit -m "chore(market): 索引指向 x.y.z 发布提交"
```

核对：`index.json` 里 `versions[0].source.commit` 必须等于发布代码那个 commit 的 sha，
`versions[0].version` 必须等于 `package.json` 的 version。

### 7. 为什么不能既手动发布又推 tag

`release.yml` 由 `v*` tag 触发，里面会再跑一次 `npm publish --provenance`。若你已经手动发布过同一版本，
这一步会因「版本已存在」失败，workflow 变红，GitHub Release 也就不一定建出来。所以二选一：

- **手动路径**：本地 `npm publish` 后，tag 只留在本地（或干脆先不打），索引照第 6 步走；
- **CI 路径**：仓库配好 `NPM_TOKEN`（或 npm trusted publishing 绑定仓库），然后 `git tag v0.1.0 && git push origin v0.1.0`，
  让 workflow 发 npm + 建 Release，本地一枪不动。

### 8. 发错了怎么办

- 24 小时内、且没有别的包依赖它：`npm unpublish dsh-workspace-capabilities@0.1.0 --force`
  （npm 的 72 小时窗口政策会更早收紧，别赌）。
- 更常见也更安全的做法：`npm deprecate dsh-workspace-capabilities@0.1.0 "原因，改用 x.y.z"` 然后发修复版。
- **不要复用一个已发布过的版本号**，registry 不允许覆盖。

## 仓库自动化

仓库已有两条 GitHub Actions：

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push `main` / PR | Ubuntu + Windows 上跑 `npm test`；覆盖率门禁只在 Ubuntu 上算（行 95% / 函数 90% / 分支 80%） |
| `.github/workflows/release.yml` | push `v*` tag | 校验 tag 与 `package.json` 版本一致 → 跑测试 → `npm publish --provenance` → 建 GitHub Release |

首次发布 npm 前，在仓库 **Settings → Secrets and variables → Actions** 里加 `NPM_TOKEN`
（npm 账号的 Automation token）。也可以改用 npm 的 trusted publishing（OIDC），
那样不需要 token，但要在 npm 包设置里先绑定仓库与工作流。手动发布同样可以：

```bash
npm publish --access public --registry https://registry.npmjs.org
```

`prepublishOnly` 会再跑一遍测试；发布前请确认 `npm pack --dry-run` 的文件清单。

## 社区渠道（可选）

自建索引解决「能装」，社区市场解决「被搜到」。三个主渠道互相独立：

| 渠道 | 要求 | 提交方式 |
| --- | --- | --- |
| [dsh.so](https://www.dsh.so/zh/submit/) | 公开仓库或 npm 包、README 含安装说明、SPDX 许可证、通过安全扫描 | 网页粘贴仓库/npm 包名，自动扫描后提交 |
| [dsh-plugin.org](https://dsh-plugin.org/zh/submit) | 公开仓库、GitHub topic `dsh-plugin`、README 含安装命令、根目录 `package.json` | 按模板开 Issue |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 一条列表项；索引由 `dsh-plugin-catalog` 发布到 npm，dsh-market 读取 | 向仓库提 PR |

本项目已具备：MIT 许可证、README 安装段、`dsh.bundle` 清单、根 `package.json`。还差公开仓库和
GitHub topic `dsh-plugin`。dsh.so 的仓库名规则 `^[a-z0-9]+(-[a-z0-9]+)*$` 也满足。

## 命名注意

npm 上的 `dsh-workspace-scope` 是 Ri0n72Y 的独立实现，已被 awesome-dsh-plugin 收录。本项目从
`0.1.0` 起使用 `dsh-workspace-capabilities`，不要用旧名发 npm，否则会和该包冲突。

## 不用 npm 也能装

索引条目用 `git` source 时，安装不需要 npm 发布，也不要求包在 npm 上存在。只有「DSH 内置插件
中心的 npm 一键安装」和部分社区站点的 npm 徽章需要真的 `npm publish`。
