---
name: reference-plain-writing-skill
description: Where the plain-writing skill CLAUDE.md requires actually lives on this machine, and what to do when it is not invocable by name
metadata:
  type: reference
---

`CLAUDE.md`'s "Prose style" rule requires the `plain-writing` skill on every
piece of prose in this repository, and says the skill may not be present. On
this machine, as of 2026-09-07, it is present but not invocable by name.

**Where it is:**
`/home/mike/Development/is4co/agent-skills/plugins/plain-writing/skills/plain-writing/SKILL.md`,
with `references/rewrites.md` and `references/document-shapes.md` beside it.

Two things make it easy to conclude wrongly that the skill is missing:

- It is not linked into `~/.claude/skills`, so it does not appear in the skill
  list and the Skill tool cannot invoke it by name.
- `/home/mike/Development/is4co/agent-skills/skills/plain-writing` is a symlink
  to the `plugins/` copy above, so both paths reach the same three files. A
  `find <dir> -type f` over it reports nothing, because `find` does not follow
  symlinks by default, and that makes the directory look empty when it is not.

Read the three files directly instead. That is the fallback `CLAUDE.md`
describes, and it satisfies the rule.

**The parts that bite hardest here:** no em dashes or en dashes anywhere, lead
every paragraph with its claim, and use a fixed status vocabulary rather than
mixing "pass"/"fail" with "green"/"clean". Existing documents in `docs/` still
carry em dashes from before the standard landed; a new or rewritten document
should not add more.

Check the path before relying on it. Related: [[feedback-no-help-output-snapshots]].
