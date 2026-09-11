#!/usr/bin/env bash
# Stop hook (architecture.md 11): the full check is the definition of done.
set -u
cd "$(dirname "$0")/../.."
input=$(cat)
# Already re-entered once because of this hook: do not loop forever.
if printf '%s' "$input" | grep -q '"stop_hook_active": *true'; then exit 0; fi
if [ -z "$(git status --porcelain --untracked-files=all -- . ':!.screenshots' 2>/dev/null)" ]; then exit 0; fi
out=$(python3 checks/check.py 2>&1) && exit 0
printf 'checks/check.py failed; fix before finishing (architecture.md section 11):\n%s\n' "$out" | tail -40 >&2
exit 2
