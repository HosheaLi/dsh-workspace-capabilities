#!/usr/bin/env bash
# scripts/wrapup.sh —— 收尾检查；默认只打印，--commit 时做一次**本地**提交
#
# 做四件事：
#   1. git status（含未跟踪文件）；
#   2. 按文件路径推断 Conventional Commits 类型与 scope，生成**草稿**提交信息（中文）；
#   3. 提醒更新 .planning/STATE.md 的三栏（进度 / 决策 / 阻塞）；
#   4. 列出需要人判断的项：敏感信息、是否入版本管理、是否要发版、用例与文档一致性。
#
# 用法：
#   bash scripts/wrapup.sh            # 只打印，不改仓库
#   bash scripts/wrapup.sh --quiet    # 只打印，不输出 diffstat 明细
#   bash scripts/wrapup.sh --commit   # 打印 + 直接本地提交（git add -A + git commit）
#
# 项目策略（2026-11-20 起）：每轮工作完成后自动做**本地**提交，不推远端。
# --commit 的安全闸：敏感信息扫描命中时拒绝提交；提交前仍应跑过 scripts/verify.sh。
# 永远不 push —— origin 是公开仓库，推送是人的决定。
#
# 退出码：默认恒为 0；--commit 时提交失败（敏感命中 / 无暂存内容以外的错误）返回 1。

set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "无法进入仓库根：$ROOT" >&2; exit 2; }

QUIET=0
COMMIT=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --commit) COMMIT=1 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（可用：--quiet / --commit）" >&2; exit 2 ;;
  esac
done

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "当前目录不是 git 工作树：$ROOT" >&2
  exit 0
fi

hr() { printf '%s\n' "------------------------------------------------------------"; }
section() { printf '\n'; hr; printf '%s\n' "$1"; hr; }

# 用 awk 而不是 paste -sd'、'：BSD paste 只取分隔符的首字节，多字节字符会被切坏成乱码。
join_cn() { awk 'NR>1{printf "、"} {printf "%s", $0} END{print ""}'; }
# 从 stdin 的文件名清单里挑出匹配某前缀的，拼成「a、b」。
pick_join() { grep -E "$1" | sed 's|^lib/||' | join_cn; }

# 文件清单要在打印 diffstat 之前就算好（未跟踪文件没有 diff，只能自己数行数）。
staged="$(git diff --cached --name-only)"
unstaged="$(git diff --name-only)"
untracked="$(git ls-files --others --exclude-standard)"
all_files="$(printf '%s\n%s\n%s\n' "$staged" "$unstaged" "$untracked" | sed '/^$/d' | sort -u)"

# ------------------------------------------------------------------ 1. git status
section "1. git status"
branch="$(git rev-parse --abbrev-ref HEAD)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$upstream" ]; then
  echo "分支：$branch（跟踪 $upstream）"
  ahead="$(git rev-list --count "$upstream..HEAD" 2>/dev/null || echo '?')"
  behind="$(git rev-list --count "HEAD..$upstream" 2>/dev/null || echo '?')"
  echo "本地领先 $ahead 个提交，落后 $behind 个提交"
else
  echo "分支：$branch（无上游）"
fi
echo ""

status_short="$(git status --short)"
if [ -z "$status_short" ]; then
  echo "工作区干净，没有待提交的改动。"
  echo "如果这轮确实改过东西，先确认是不是改在了别的仓库（~/.dsh、~/.agents、~/code/Vault 都是独立仓库）。"
  changed=0
else
  printf '%s\n' "$status_short"
  changed=1
fi

if [ "$changed" -eq 1 ] && [ "$QUIET" -eq 0 ]; then
  echo ""
  if [ -n "$(git diff HEAD --stat)" ]; then
    echo "改动量（相对 HEAD，含已暂存与未暂存；未跟踪文件不计入）："
    git diff HEAD --stat | tail -30
  fi
  if [ -n "$untracked" ]; then
    echo "未跟踪文件行数（git 没有 diff 可比）："
    for f in $untracked; do
      [ -f "$f" ] && printf '  %6s 行  %s\n' "$(wc -l < "$f" | tr -d ' ')" "$f"
    done
  fi
fi

# ------------------------------------------------------------------ 分类计数
count_of() { printf '%s\n' "$all_files" | grep -cE "$1" 2>/dev/null || true; }

has_lib="$(count_of '^lib/')"
has_test="$(count_of '^test/')"
has_docs="$(count_of '^(docs/|AGENTS\.md|CHANGELOG\.md|README)')"
has_scripts="$(count_of '^scripts/')"
has_ci="$(count_of '^\.github/')"
has_meta="$(count_of '^(package\.json|index\.json|cordis\.patch\.yml)')"
has_planning="$(count_of '^\.planning/')"

# 敏感信息扫描：跟踪文件的 diff（含已暂存）+ 未跟踪文件的文件名启发式。
# 启发式不等于审计，命中要人看，未命中也不能保证干净。
scan_secrets() {
  local hits=""
  hits="$(git diff HEAD | grep -inE '^\+.*(api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]*PRIVATE KEY)' \
    | grep -viE '(apiKeyEnv|env var|环境变量|令牌名|token\b.*字段|NPM_TOKEN|DEEPSEEK_API_KEY)' | head -10)"
  for f in $untracked; do
    case "$f" in
      *.env|*.secret.*|*.local.json|.credentials.yaml|*/.credentials.yaml|*credentials*)
        hits="${hits:+$hits
}  未跟踪的疑似凭据文件：$f" ;;
    esac
  done
  printf '%s' "$hits"
}
sec_hits="$(scan_secrets)"

# ------------------------------------------------------------------ 2. 建议提交信息（草稿）
section "2. 建议提交信息（草稿：type/scope 由文件路径推断，主语须人工确认）"

if [ "$changed" -eq 0 ]; then
  echo "无可提交改动，跳过。"
  subject=""
else
  # 先按类别归类，再决定 type：单一类别走该类别，跨类别说明这是一锅烩，用 chore 并提示拆分。
  cats=""
  [ "$has_lib" -gt 0 ] && cats="$cats code"
  [ "$has_test" -gt 0 ] && cats="$cats test"
  [ "$has_docs" -gt 0 ] && cats="$cats docs"
  [ "$has_scripts" -gt 0 ] && cats="$cats scripts"
  [ "$has_ci" -gt 0 ] && cats="$cats ci"
  [ "$has_meta" -gt 0 ] && cats="$cats meta"
  [ "$has_planning" -gt 0 ] && cats="$cats planning"
  cat_count="$(printf '%s\n' $cats | sed '/^$/d' | wc -l | tr -d ' ')"

  scope=""
  if [ "$cat_count" -gt 1 ]; then
    type="chore"
    echo "这批改动跨 ${cat_count} 类（$(printf '%s\n' $cats | sed '/^$/d' | join_cn)）。"
    echo "建议拆成多个提交：代码一个、测试一个、文档/脚本各一个。下面的草稿是合并提交的兜底。"
    echo ""
  else
    case "${cats# }" in
      code)
        adds="$(git diff HEAD --numstat -- lib 2>/dev/null | awk '{a+=$1; d+=$2} END {print (a?a:0)" "(d?d:0)}')"
        add_n="${adds% *}"; del_n="${adds#* }"
        if [ "${add_n:-0}" -gt $(( ${del_n:-0} * 3 )) ]; then type="feat"; else type="fix"; fi
        top_lib="$(printf '%s\n' "$all_files" | grep -E '^lib/' | head -1 | sed 's|^lib/||; s|\.js$||')"
        scope="$top_lib"
        ;;
      test) type="test"; scope="test" ;;
      docs) type="docs" ;;
      scripts) type="chore"; scope="scripts" ;;
      ci) type="ci"; scope="ci" ;;
      meta) type="chore" ;;
      planning) type="chore"; scope="planning" ;;
      *) type="chore" ;;
    esac
  fi

  # 主语草稿：只描述"动了什么"，不猜"为什么"——为什么必须人来补。
  subject_tail=""
  [ "$has_lib" -gt 0 ] && subject_tail="调整 $(printf '%s\n' "$all_files" | pick_join '^lib/')"
  [ "$has_test" -gt 0 ] && subject_tail="${subject_tail:+$subject_tail；}同步测试"
  [ "$has_docs" -gt 0 ] && subject_tail="${subject_tail:+$subject_tail；}更新文档 $(printf '%s\n' "$all_files" | pick_join '^(docs/|AGENTS\.md|README|CHANGELOG)')"
  [ "$has_scripts" -gt 0 ] && subject_tail="${subject_tail:+$subject_tail；}新增 / 调整 $(printf '%s\n' "$all_files" | pick_join '^scripts/')"
  [ "$has_ci" -gt 0 ] && subject_tail="${subject_tail:+$subject_tail；}调整 CI"
  [ "$has_meta" -gt 0 ] && subject_tail="${subject_tail:+$subject_tail；}调整包元数据"
  [ "$has_planning" -gt 0 ] && subject_tail="${subject_tail:+$subject_tail；}更新项目状态"
  [ -z "$subject_tail" ] && subject_tail="更新 $(printf '%s\n' "$all_files" | head -3 | join_cn)"

  if [ -n "$scope" ]; then
    subject="$type($scope): $subject_tail"
  else
    subject="$type: $subject_tail"
  fi

  echo "草稿："
  echo "  $subject"
  echo ""
  echo "正文建议（分组列出、写清为什么；只列出文件等于没说）："
  printf '%s\n' "$all_files" | sed 's/^/  - /'
  subj_len="$(printf '%s' "$subject" | wc -m | tr -d ' ')"
  if [ "$subj_len" -gt 72 ]; then
    echo ""
    echo "[提示] 主语 ${subj_len} 字符，超过 72，建议手改短一些。"
  fi

  if [ "$COMMIT" -eq 1 ]; then
    echo ""
    echo "== 自动提交（本地提交，不推远端）=="
    if [ -n "$sec_hits" ]; then
      echo "拒绝提交：敏感信息扫描命中（明细见第 4 节）。人工处理后再跑。"
      exit 1
    fi
    git add -A
    if [ -z "$(git diff --cached --name-only)" ]; then
      echo "暂存区为空，没有可提交的内容。"
      exit 0
    fi
    git commit -q -F - <<COMMIT
$subject

- 涉及文件：
$(printf '%s\n' "$all_files" | sed 's/^/  - /')
- 由 scripts/wrapup.sh --commit 自动生成提交
COMMIT
    echo "已提交：$(git log -1 --oneline)"
    echo "未推送。如需推送先确认 origin 是公开仓库、diff 里没有本机私有信息。"
  else
    echo ""
    echo "要执行的命令（复制后自己改主语，再执行）："
    echo ""
    cat <<MSG
git add -A
git commit -F - <<'COMMIT'
$subject

- TODO：一句话说明这批改动的目的（为什么改，不是改了什么）
- 涉及文件：
$(printf '%s\n' "$all_files" | sed 's/^/  - /')
COMMIT
MSG
    echo ""
    echo "提交前：git diff --cached 里不得出现密钥、token、本机绝对路径里的真实用户名。"
    echo "本项目的策略是每轮结束本地提交；需要脚本代劳时用 --commit（仍不 push）。"
  fi
fi

# ------------------------------------------------------------------ 3. STATE 三栏
section "3. 更新 .planning/STATE.md 的三栏"
if [ -f .planning/STATE.md ]; then
  echo "本文件存在。逐栏自查，只改需要改的行："
  echo "  - 进度：这轮做完的项改「完成」并补证据（命令 + 关键输出）；没验证的写「未验证」"
  echo "  - 决策：本轮做出的取舍写一行（日期 / 决策 / 理由），没做决策就不加"
  echo "  - 阻塞：新增或解除的阻塞；解除后要说明怎么解除的"
  echo ""
  if printf '%s\n' "$all_files" | grep -q '^\.planning/STATE\.md$'; then
    echo "注意：STATE.md 本身在本轮改动里，提交时别忘了它。"
  fi
  echo "需要人判断：本轮是否改变了项目「档位」（活跃 / 接手中 / 半废弃）。改了就更新文件和汇报口径。"
else
  echo "缺 .planning/STATE.md。按项目约定应存在（三栏：进度 / 决策 / 阻塞），先补再提交。"
fi

# ------------------------------------------------------------------ 4. 需要人判断
section "4. 需要人判断的项"

flag() { printf '  [ ] %s\n' "$1"; }

# 4.1 敏感信息（sec_hits 在 --commit 分支里也用作拒绝提交的闸）
if [ -n "$sec_hits" ]; then
  echo "敏感信息命中，人工确认："
  printf '%s\n' "$sec_hits" | sed 's/^/    /'
else
  flag "密钥扫描未命中（启发式，不等于审计：请自己过一遍 git diff --cached）"
fi

# 4.2 未跟踪文件是否该入版本管理
if [ -n "$untracked" ]; then
  echo "未跟踪文件（先判断该不该提交）："
  printf '%s\n' "$untracked" | sed 's/^/    /'
fi

# 4.3 代码改了但没补测试
if [ "$has_lib" -gt 0 ] && [ "$has_test" -eq 0 ]; then
  flag "改了 lib/ 但没动 test/ —— 新增/修改的行为要不要对应用例？（非平凡逻辑走 RED → GREEN）"
fi

# 4.4 发版相关
if printf '%s\n' "$all_files" | grep -qx 'package.json'; then
  old_ver="$(git show HEAD:package.json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).version)}catch{console.log('?')}})" 2>/dev/null || echo '?')"
  new_ver="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
  if [ "$old_ver" != "$new_ver" ]; then
    echo "版本号变化：$old_ver → $new_ver"
    flag "发版流程：npm run build:index（把 index.json 钉到发布 commit）→ 提交 → 推 v$new_ver tag（人判，需 NPM_TOKEN）"
    flag "CHANGELOG.md 是否已加对应版本小节与日期"
  fi
fi
if printf '%s\n' "$all_files" | grep -q '^index\.json$'; then
  flag "index.json 变了：确认用 npm run build:index 生成，不是手改；并跑 npm run check:index（需官方校验器）"
fi

# 4.5 文档一致性
if printf '%s\n' "$all_files" | grep -qE '^README\.md$'; then
  if ! printf '%s\n' "$all_files" | grep -qE '^README\.en\.md$'; then
    flag "README.md 改了但 README.en.md 没改 —— 两者是并行维护的"
  fi
fi
if [ "$has_lib" -gt 0 ] && printf '%s\n' "$all_files" | grep -qE '^(README|docs/)'; then
  flag "代码与文档同时改动：确认 README（使用者）/ architecture.md（机制）/ development.md（测试口径）三处口径一致"
fi
if printf '%s\n' "$all_files" | grep -qE '^(lib/|test/|\.github/)'; then
  flag "改了 test/ 或 lib/ 后，用例数陈述记得同步（README ×2、README.en ×2、architecture、development 三处）"
fi

# 4.6 常识项
if [ "$COMMIT" -eq 0 ]; then
  flag "是否提交（git commit）——本次只打印；要自动提交用 --commit"
fi
flag "是否推远端（默认不推；origin 是公开仓库，推之前确认没有本机私有信息）"
flag "要不要重跑门禁：bash scripts/verify.sh（本轮没跑过就没有证据说它绿）"

printf '\n'
if [ "$COMMIT" -eq 1 ]; then
  echo "（本次执行了 git add + git commit；没有 push。）"
else
  echo "（本脚本只打印，没有执行任何 git 写操作。）"
fi
exit 0
