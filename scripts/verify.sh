#!/usr/bin/env bash
# scripts/verify.sh —— 本仓库唯一的验证入口：构建 + 测试 + lint
#
# 用法：
#   bash scripts/verify.sh              # 全部跑一遍，退出码 0 = 通过
#   bash scripts/verify.sh --no-coverage  # 跳过覆盖率门禁（省 2 秒，CI 不等价）
#
# 依赖：无。本仓库零运行时依赖（package.json 无 dependencies），**不需要** npm install；
#   node_modules/ 不存在也能全绿（2026-11-20 实测）。Node ≥ 22（package.json engines），
#   本机 Node v26.13.0 全绿。跑宿主本身要另外用 App 自带 node，见 docs/development.md。
#
# 三件事的实情 —— 缺哪项写在这里，不假装有：
#
#   构建：**没有构建步骤**。lib/client.js 是手写的浏览器 bundle（window.__ModuleLoader__.load），
#     本身就是发布产物；lib/*.js 是 ESM 源码直跑，没有 tsc / bundler / 产物目录 / build 脚本。
#     所以这门禁退一步做「语法与模块解析自检」：node --check 逐文件解析 lib/*.js 与
#     tools/*.mjs。它能抓住语法错误、误用 ESM 语法等，但抓不住类型错误和逻辑错误。
#
#   测试：包一层已有脚本，不重写。
#     - npm test              = node --test "test/**/*.test.js"（172 用例；缺
#                               /tmp/dshref/runtime 时 23 条集成用例整组 skip，属预期）
#     - npm run test:coverage = CI 同款门禁：行 95% / 函数 90% / 分支 80%
#                              （CI 只在 ubuntu-latest 上算，本脚本本机也算）
#
#   lint：**没有**。仓库里没有 eslint / prettier / biome / editorconfig 配置，
#     package.json 也没有 lint 脚本，CI 里同样没有 lint 步骤。不在这里另立一套 lint 标准，
#     只做两项零成本、客观可判的检查：
#       1) git diff --check —— 空白错误、冲突标记
#       2) JSON 可解析 —— index.json（市场索引）与 .dsh/skills-scope.json（本仓库自身配置）
#
# 可选：市场索引校验（tools/check-market-index.mjs）需要官方校验器
#   @deepseek-ai/dsh-plugin-market-index，它不在 dependencies 里（本包零依赖）。
#   装了才跑，没装打印跳过原因，不计入失败：
#     npm install --prefix /tmp/dsh-market-check @deepseek-ai/dsh-plugin-market-index
#     DSH_MARKET_INDEX_MODULE=/tmp/dsh-market-check/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js \
#       bash scripts/verify.sh

set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "无法进入仓库根：$ROOT" >&2; exit 2; }

RUN_COVERAGE=1
for arg in "$@"; do
  case "$arg" in
    --no-coverage) RUN_COVERAGE=0 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（可用：--no-coverage）" >&2; exit 2 ;;
  esac
done

PASSED=""
FAILED=""
SKIPPED=""

hr() { printf '%s\n' "------------------------------------------------------------"; }

record() { # record <通过|失败|跳过> <名称>
  case "$1" in
    通过) PASSED="$PASSED
  [通过] $2" ;;
    失败) FAILED="$FAILED
  [失败] $2" ;;
    跳过) SKIPPED="$SKIPPED
  [跳过] $2" ;;
  esac
}

step() { printf '\n== %s ==\n' "$1"; }

echo "仓库：$ROOT"
echo "node：$(node -v 2>/dev/null || echo '缺失')"
hr

# ---------------------------------------------------------------- 1. 构建（语法自检）
step "构建：无构建步骤 → 代跑 node --check 语法自检"

if ! command -v node >/dev/null 2>&1; then
  echo "缺少 node，无法继续"
  record 失败 "构建/语法自检（node 缺失）"
else
  syntax_fail=0
  syntax_files=0
  for f in lib/*.js tools/*.mjs; do
    [ -f "$f" ] || continue
    syntax_files=$((syntax_files + 1))
    if ! node --check "$f"; then
      echo "  语法错误：$f"
      syntax_fail=$((syntax_fail + 1))
    fi
  done
  echo "已解析 $syntax_files 个文件，失败 $syntax_fail 个"
  if [ "$syntax_fail" -eq 0 ]; then
    record 通过 "构建/语法自检（$syntax_files 个文件）"
  else
    record 失败 "构建/语法自检（$syntax_fail 个文件解析失败）"
  fi
fi

# ---------------------------------------------------------------- 2. lint（无 lint 配置）
step "lint：仓库无 lint 配置 → 只跑空白错误与 JSON 可解析"

whitespace_ok=1
if git rev-parse --git-dir >/dev/null 2>&1; then
  if ! git diff --check; then
    whitespace_ok=0
    echo "git diff --check 报出空白错误（见上）"
  else
    echo "git diff --check：干净"
  fi
  if ! git diff --cached --check; then
    whitespace_ok=0
    echo "git diff --cached --check 报出空白错误（见上）"
  fi
else
  echo "不在 git 工作树里，跳过 diff --check"
fi

json_ok=1
for j in index.json .dsh/skills-scope.json package.json locale/en.json locale/zh.json; do
  [ -f "$j" ] || { echo "  缺文件：$j"; json_ok=0; continue; }
  if node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'))" "$j"; then
    echo "  JSON 可解析：$j"
  else
    echo "  JSON 解析失败：$j"
    json_ok=0
  fi
done

if [ "$whitespace_ok" -eq 1 ] && [ "$json_ok" -eq 1 ]; then
  record 通过 "lint 替代项（空白 + JSON）"
else
  record 失败 "lint 替代项（空白=$whitespace_ok JSON=$json_ok）"
fi

# ---------------------------------------------------------------- 3. 测试
step "测试：npm test（172 用例；23 条集成缺运行时 skip 属预期）"
if npm test; then
  record 通过 "npm test"
else
  record 失败 "npm test"
fi

# ---------------------------------------------------------------- 4. 覆盖率门禁
if [ "$RUN_COVERAGE" -eq 1 ]; then
  step "覆盖率门禁：npm run test:coverage（行 95 / 函数 90 / 分支 80）"
  if npm run test:coverage; then
    record 通过 "npm run test:coverage"
  else
    record 失败 "npm run test:coverage"
  fi
else
  echo ""
  echo "（--no-coverage：覆盖率门禁未跑，本结果不等价于 CI）"
  record 跳过 "npm run test:coverage（--no-coverage）"
fi

# ---------------------------------------------------------------- 5. 可选：市场索引校验
step "可选：市场索引校验（需要官方 @deepseek-ai/dsh-plugin-market-index）"
if [ -n "${DSH_MARKET_INDEX_MODULE:-}" ] && [ -e "${DSH_MARKET_INDEX_MODULE}" ]; then
  if node tools/check-market-index.mjs; then
    record 通过 "tools/check-market-index.mjs"
  else
    record 失败 "tools/check-market-index.mjs"
  fi
elif node -e "import('@deepseek-ai/dsh-plugin-market-index').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
  if node tools/check-market-index.mjs; then
    record 通过 "tools/check-market-index.mjs"
  else
    record 失败 "tools/check-market-index.mjs"
  fi
else
  echo "跳过：官方校验器未安装（本包零依赖，不自动装）。"
  echo "      装法见 docs/publishing.md「发布步骤」第 5 步（别按行号找，会漂），或把 DSH_MARKET_INDEX_MODULE 指到已装好的 lib/index.js。"
  record 跳过 "tools/check-market-index.mjs（缺 @deepseek-ai/dsh-plugin-market-index）"
fi

# ---------------------------------------------------------------- 汇总
printf '\n'
hr
echo "汇总"
hr
printf '%s\n' "${PASSED:-  （无）}"
printf '%s\n' "${SKIPPED:-  （无跳过）}"
if [ -n "$FAILED" ]; then
  printf '%s\n' "$FAILED"
  echo ""
  echo "结果：有失败项，verify 未通过"
  exit 1
fi
if [ "$RUN_COVERAGE" -eq 0 ]; then
  echo ""
  echo "结果：通过（跳过覆盖率门禁，不等价于 CI）"
  exit 0
fi
echo ""
echo "结果：通过"
exit 0
