- [Commander negated flags](commander-negated-flags.md): `--no-x` parses to
  `x: false`, never `noX`
- [Dispatch a real CI run](dispatch-a-real-ci-run.md): a workflow change needs
  two dispatches, not one
- [Adopt the theme, not the palette](feedback-adopt-the-theme-not-the-palette.md):
  unchanged output on a default host is not an adoption
- [No pinned literals in tests](feedback-no-help-output-snapshots.md): read the
  expected value off its source of truth
- [Platform-code selection traps](platform-code-selection-traps.md): no OS
  condition exists in package exports
- [chalk downsamples pastels to white](reference-chalk-downsamples-to-white.md):
  at colour level 1, `hex()` answers white for most Catppuccin accents
- [session-daemon platform risk](session-daemon-platform-risk.md): a platform
  reader that answers `null` disables its guards and says nothing
- [Testing a TTY-only path](testing-a-tty-only-path.md): give a spawned CLI a
  real pty with `script`
- [Reading a retried test failure](reading-a-retried-test-failure.md): the error
  on the last attempt may belong to an earlier one
- [Workspace is reconstructed from a path](workspace-is-reconstructed-from-a-path.md):
  nothing records which workspaces exist
