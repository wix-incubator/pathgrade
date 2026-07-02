#!/usr/bin/env bash
set -euo pipefail

limit="${MAX_FILE_LINES:-600}"
root="${1:-.}"

if ! [[ "$limit" =~ ^[0-9]+$ ]]; then
  echo "MAX_FILE_LINES must be a positive integer, got: $limit" >&2
  exit 2
fi

case "$root" in
  */) root="${root%/}" ;;
esac

allowlist_cap() {
  case "$1" in
    src/agents/codex-app-server/agent.ts) echo 811 ;;
    src/viewer.html) echo 1178 ;;
    tests/claude-ask-user-bridge.test.ts) echo 604 ;;
    tests/claude-sdk-driver.test.ts) echo 697 ;;
    tests/claude-sdk-projector.test.ts) echo 774 ;;
    tests/codex-app-server-agent.test.ts) echo 1285 ;;
    tests/commands.run-changed.test.ts) echo 609 ;;
    tests/converse.test.ts) echo 608 ;;
    tests/grading-pipeline.test.ts) echo 691 ;;
    tests/sandbox.test.ts) echo 916 ;;
    *)
      return 1
      ;;
  esac
}

should_skip() {
  case "$1" in
    .yarn/* | \
    .worktrees/* | \
    dist/* | \
    coverage/* | \
    .pathgrade/* | \
    docs/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

should_check() {
  case "$1" in
    *.cjs|*.js|*.jsx|*.mjs|*.mts|*.ts|*.tsx|*.json|*.jsonc|*.html|*.css|*.md|*.sh|*.toml|*.yaml|*.yml)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

emit_files() {
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$root" ls-files -z
  else
    find "$root" \
      \( -path "*/.git" -o -path "*/node_modules" -o -path "*/dist" -o -path "*/build" -o -path "*/coverage" -o -path "*/.next" -o -path "*/.nuxt" -o -path "*/.turbo" -o -path "*/.cache" \) -prune \
      -o -type f -print0
  fi
}

fail=0

while IFS= read -r -d '' file; do
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    display="$file"
    path="$root/$file"
  else
    display="${file#"$root"/}"
    path="$file"
  fi

  should_skip "$display" && continue
  should_check "$display" || continue

  lines="$(wc -l < "$path" | tr -d '[:space:]')"

  if (( lines > limit )); then
    if cap="$(allowlist_cap "$display")"; then
      if (( lines > cap )); then
        printf '%s:%s lines exceeds legacy cap %s and limit %s\n' "$display" "$lines" "$cap" "$limit"
        fail=1
        continue
      fi

      printf '%s:%s lines exceeds limit %s (legacy cap %s)\n' "$display" "$lines" "$limit" "$cap"
      continue
    fi

    printf '%s:%s lines exceeds limit %s\n' "$display" "$lines" "$limit"
    fail=1
  fi
done < <(emit_files)

if (( fail == 0 )); then
  echo "All checked files are within ${limit} lines, excluding documented legacy debt."
fi

exit "$fail"
