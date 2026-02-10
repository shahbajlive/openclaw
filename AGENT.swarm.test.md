# Team Orchestration Improvement Cycle

This file captures the repeatable workflow for diagnosing and fixing team coordination issues.

## Current Focus

- Run case: Sequential Headcount
- Log dir: `/tmp/openclaw-team-tests/`
- Vitest config: `/tmp/vitest.live-team.config.ts`

## Cycle Steps

1. Run live test for a single case.
2. Store the full log.
3. Investigate and summarize failure modes.
4. Hypothesize fixes (specific code or prompt changes).
5. Apply changes.
6. Re-run the same case.
7. If fixed, document results and move to the next issue. If not, repeat.

## Run Command (Sequential Headcount)

```bash
OPENCLAW_LIVE_TEAM_TEST=1 \
OPENCLAW_LIVE_TEAM_CASES="Sequential Headcount" \
pnpm vitest run --config /tmp/vitest.live-team.config.ts \
2>&1 | tee /tmp/openclaw-team-tests/run-001-sequential.log
```

## Log Review Checklist

- Did the team reach idle? (no pending/blocked/inProgress tasks, no active/spawning teammates)
- Any `message` tool failures: "Explicit message target required"
- Any `teammate_message` validation errors
- Any `team_create` repeats (team already exists)
- Any timeouts: `announce queue drain failed` or gateway connect timeout
- Any unexpected `sessions_send` usage

## Notes Template

```text
Run ID: run-001-sequential
Outcome: PASS/FAIL
Key failures:
- ...
Hypothesis:
- ...
Fix applied:
- ...
Re-test result:
- ...
```
