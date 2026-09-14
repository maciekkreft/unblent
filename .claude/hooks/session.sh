#!/usr/bin/env bash
# Session-aware hooks (architecture.md 11): the full check is the definition of
# done, but several Claude Code tabs share this one working tree. Each session
# is tracked by its own marker, so the Stop hook runs the full check only in a
# session that changed the tree, and never because another tab did.
#   pre   PreToolUse(Bash): remember the tree before the command
#   post  PostToolUse(Edit|Write|MultiEdit|Bash): mark the session if it changed the tree
#   stop  Stop: run the full check once for a marked session
set -u
cd "$(dirname "$0")/../.."
state=${TMPDIR:-/tmp}/unblent-hooks
mkdir -p "$state"
input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
[ -n "$sid" ] || exit 0
marker=$state/$sid.edited
tree=$state/$sid.tree

# Content of every change against HEAD, plus the identity of every untracked file.
tree_hash() {
  { git diff HEAD --no-color; git ls-files --others --exclude-standard -z | xargs -0 -r stat -c '%n %Y %s'; } 2>/dev/null | sha256sum
}

case ${1:-} in
  pre)
    tree_hash > "$tree" ;;
  post)
    tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
    case $tool in
      Edit|Write|MultiEdit) touch "$marker" ;;
      Bash) [ -f "$tree" ] && [ "$(tree_hash)" != "$(cat "$tree")" ] && touch "$marker" ;;
    esac
    exit 0 ;;
  stop)
    # Already re-entered once because of this hook: do not loop forever.
    [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = true ] && exit 0
    [ -f "$marker" ] || exit 0
    if [ -z "$(git status --porcelain --untracked-files=all -- . ':!.screenshots' 2>/dev/null)" ]; then
      rm -f "$marker"; exit 0
    fi
    # One full check at a time across tabs: they share the test port and the CPU.
    out=$(flock -w 240 "$state/check.lock" python3 checks/check.py 2>&1) && { rm -f "$marker"; exit 0; }
    printf 'checks/check.py failed; fix before finishing (architecture.md section 11):\n%s\n' "$out" | tail -40 >&2
    exit 2 ;;
esac
