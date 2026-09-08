---
name: reference-chalk-downsamples-to-white
description: chalk's hex() at colour level 1 maps most Catppuccin dark-flavour accents to white or bright white, so a truecolour path cannot be reused at 16 colours
metadata:
  type: reference
---

`new Chalk({ level: 1 }).hex(...)` runs a nearest-colour search, and for pastel
palettes it answers white. Measured against all four Catppuccin flavours in this
repository:

| flavour   | green | teal | yellow | red | blue |
| --------- | ----- | ---- | ------ | --- | ---- |
| latte     | 32    | 36   | 33     | 31  | 94   |
| frappe    | 37    | 37   | 37     | 97  | 97   |
| macchiato | 37    | 37   | 97     | 97  | 97   |
| mocha     | 37    | 36   | 97     | 97  | 97   |

So on a 16-colour terminal a single `hex()` path collapses success, warning,
error and heading into white, and every distinction the roles exist to make is
gone. Level 2 downsamples sanely (mocha green to index 151, red 217, yellow 223).

**How to apply:** anywhere werk writes a palette colour, branch on the level and
write an explicit ANSI slot at level 1 rather than letting the library choose.
`packages/werk/src/runtime/style.ts` does this, and `@werk/palette`'s
`fallbackSlot` supplies the slot for the eight Catppuccin accents that have none
upstream. The trap is easy to reintroduce because the truecolour path looks
correct and nobody tests at level 1 by accident;
`packages/werk/test/style.test.ts` holds it shut with a test that forbids SGR 37
and 97 on any coloured role.

Catppuccin itself has no position here: its ports require 24-bit colour and
several name terminals they will not work on. What werk does at sixteen colours
is werk's own decision and the docs say so.

Related: [[feedback-adopt-the-theme-not-the-palette]].
