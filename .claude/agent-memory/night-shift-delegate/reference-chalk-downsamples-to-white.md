---
name: reference-chalk-downsamples-to-white
description: chalk's hex() at colour level 1 maps most Catppuccin dark-flavour accents to white, so a truecolour path cannot be reused at sixteen colours
metadata:
  type: reference
---

`new Chalk({ level: 1 }).hex(...)` runs a nearest-colour search and answers
white for pastel palettes, measured across the four Catppuccin flavours. Each
cell is the ANSI SGR code chalk emitted, where 37 is white and 97 is bright
white:

| flavour   | green | teal | yellow | red | blue |
| --------- | ----- | ---- | ------ | --- | ---- |
| latte     | 32    | 36   | 33     | 31  | 94   |
| frappe    | 37    | 37   | 37     | 97  | 97   |
| macchiato | 37    | 37   | 97     | 97  | 97   |
| mocha     | 37    | 36   | 97     | 97  | 97   |

At sixteen colours one `hex()` path collapses success, warning, error and
heading into white. Level 2 downsamples sanely.

So branch on the level and write an explicit ANSI slot at level 1.
`packages/werk/src/runtime/style.ts` does this, and `@werk/palette`'s
`fallbackSlot` covers the eight accents that have no slot upstream.
The truecolour path looks correct, so `packages/werk/test/style.test.ts` forbids
SGR 37 and 97 on any coloured role.
