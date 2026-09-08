---
name: format-check-scans-agent-memory
description: werk's `bun run format:check` runs `prettier --check .`, which includes `.claude/agent-memory/`; another agent's unformatted memory file fails the gate in the primary checkout
metadata:
  type: project
---

`bun run format:check` in werk is `prettier --check .` with no exclusion for `.claude/agent-memory/`, so an untracked memory file another agent wrote (typically `*emphasis*` where prettier wants `_emphasis_`) fails the gate even when the change under test is clean.

**Why:** Seen 2026-09-07 while integrating the platform-bugs branch: every gate passed and format:check failed only on `.claude/agent-memory/night-shift-delegate/...md`, an untracked file from a concurrently running delegate.

**How to apply:** When format:check fails, read the warned file list before touching anything. If the only offenders are outside the unit, confirm with `bunx prettier --check . '!<file>'` and report it as an environment fault with the exact `bunx prettier --write <file>` fix, rather than editing another agent's memory file mid-run.
