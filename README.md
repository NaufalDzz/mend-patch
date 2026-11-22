# mend-patch

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NaufalDzz/mend-patch/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NaufalDzz/mend-patch/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Spec-complete deterministic Node 22 CLI (`mend`) implementing all four AI edit formats in `SPEC.md`: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits, with 3-tier line matching, tier-2 re-indentation, CRLF and EOF newline handling, and atomic all-or-nothing commits.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Run the 100 public practice checks:

```sh
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
