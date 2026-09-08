---
name: werk-gates
description: The gate commands a werk fix round must run, their order, and the missing plain-writing skill
metadata:
  type: project
---

Run `bun run build` before `bun run typecheck`; typecheck fails from a clean tree otherwise (pre-existing, not a fault to fix). The full set the verifier re-runs is `bun run build`, `bun run typecheck`, `bun run test`, `bun test scripts/ci-run.test.ts`, `bun run format:check` (run `bun run format` first). The `plain-writing` skill CLAUDE.md asks for is usually absent on this machine; write to CLAUDE.md's prose section and say so in the report.

**Why:** Stated by the dispatching delegate on the issue-18 palette round (2026-09-07); the typecheck ordering cost a round elsewhere.

**How to apply:** Chain the gates in that order in one command at the end of every fix round; do not treat a clean-tree typecheck failure as a code fault.
