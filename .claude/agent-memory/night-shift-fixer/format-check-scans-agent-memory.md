---
name: format-check-scans-agent-memory
description: bun run format:check covers .claude/agent-memory, so another agent's unformatted memory file fails the gate when the change under test is clean
metadata:
  type: project
---

`bun run format:check` is `prettier --check .` with no exclusion for
`.claude/agent-memory/`, so an untracked memory file another agent is part way
through writing fails the gate. The usual offender is `*emphasis*` where
prettier wants `_emphasis_`.

Read the warned file list before touching anything. If the only offenders are
outside your unit, confirm with `bunx prettier --check . '!<file>'` and report
an environment fault naming the `bunx prettier --write <file>` fix. Do not edit
another agent's memory file mid-run.
