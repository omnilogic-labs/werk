---
name: workspace-is-reconstructed-from-a-path
description: Nothing records which workspaces exist, so a workspace is worked back to from a session's cwd; the join and its inverse must stay together
metadata:
  type: project
---

Nothing records which workspaces exist, so anything that has to name one after
the fact works back to it from the directory the session was started in, with
`localWorkspaceAt` in `@werk/workspace`. Only `create` ever holds a real
`Workspace`.

**Why:** where the record of a workspace lives is open (product-specification
question 19, no lean), so there is no index to consult. Reconstruction reaches
exactly as far as this host's own layout.

**How to apply:** if you add a place that names a workspace, expect a path and
not a name. Keep `localWorkspaceAt` beside the join in `local.ts` that builds
the directory: they are inverses and a test asserts the round trip against a
workspace a real host made, so moving one without the other breaks it.
