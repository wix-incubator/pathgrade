#!/usr/bin/env bash
set -euo pipefail

root="${1:-.}"
cd "$root"

release_scripts=()
while IFS= read -r file; do
  release_scripts+=("$file")
done < <(find scripts/release -type f -name '*.mjs' 2>/dev/null | sort)

for file in "${release_scripts[@]}"; do
  if ! node --check "$file"; then
    echo "Release script failed syntax validation: $file" >&2
    exit 1
  fi
done

if (( ${#release_scripts[@]} > 0 )); then
  echo "Release-script syntax boundaries are clean (${#release_scripts[@]} files)."
fi

result_capture_files=()
while IFS= read -r file; do
  result_capture_files+=("$file")
done < <(
  {
    [[ -f src/sdk/result-capture.ts ]] && printf '%s\n' src/sdk/result-capture.ts
    [[ -d src/sdk/result-capture ]] && find src/sdk/result-capture -type f \( -name '*.ts' -o -name '*.mts' -o -name '*.tsx' \)
  } | sort -u
)

if (( ${#result_capture_files[@]} == 0 )); then
  echo "No result-capture module found yet; Pillar 1 boundary check is armed."
  exit 0
fi

forbidden_module="(vitest|vitest/config|vitest/node|@wix/pathgrade/plugin|\\.\\.?/.*plugin|\\.\\.?/.*plugin/.*)"
pattern="from\\s+['\"]${forbidden_module}['\"]|import\\s*['\"]${forbidden_module}['\"]|import\\s*\\(\\s*['\"]${forbidden_module}['\"]\\s*\\)|require\\s*\\(\\s*['\"]${forbidden_module}['\"]\\s*\\)"

if rg --line-number --pcre2 "$pattern" "${result_capture_files[@]}"; then
  echo "Result capture must not import Vitest or the plugin layer." >&2
  exit 1
fi

echo "Result-capture boundary imports are clean."
