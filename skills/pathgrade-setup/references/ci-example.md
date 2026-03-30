# CI Integration Example

## GitHub Actions Workflow

```yaml
name: Skill Evaluation
on:
  push:
    branches: [main]
  pull_request:

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Pathgrade
        run: npm i -g pathgrade

      - name: Run evaluations
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: |
          cd skills/my-skill
          pathgrade --regression --ci
```

## Key Flags for CI

| Flag | Description |
|------|-------------|
| `--ci` | Exit non-zero if pass rate is below threshold |
| `--threshold=0.8` | Set the pass rate threshold (default: 0.8) |
| `--regression` | Run 30 trials for high-confidence detection |
| `--output=DIR` | Save reports to a specific directory for artifact upload |

## Uploading Reports as Artifacts

```yaml
      - name: Upload eval reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: pathgrade-reports
          path: skills/my-skill/results/
```
