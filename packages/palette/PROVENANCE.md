# Where these colours came from

The palette is [Catppuccin](https://github.com/catppuccin/catppuccin), MIT
licensed, copyright (c) 2021 Catppuccin. `LICENSE.catppuccin` is the upstream
notice, kept here because the hex values in `src/index.ts` are copied from it.

## What was copied

From `@catppuccin/palette` version **1.8.0**, which publishes
[`palette.json`](https://github.com/catppuccin/palette/blob/main/palette.json):

- The twenty-six named colours — the fourteen accents and the twelve-step
  monochromatic ramp — of the two flavours werk names, `latte` and `mocha`,
  each as its `hex`.
- The sixteen ANSI colours of each flavour, from that flavour's `ansiColors`,
  ordered by the `code` upstream gives them: the eight `normal` entries at slots
  0-7 and the eight `bright` entries at slots 8-15.

Frappé and Macchiato are not copied. Nothing else in the upstream package is
used: `rgb`, `hsl` and `oklch` are not copied, and `rgb` here is derived from
the hex.

## What is derived rather than copied

- `Swatch.rgb` is the hex parsed to a packed integer, for the renderer.
- `Swatch.ansi` is the slot found by looking the colour's hex up in its own
  flavour's sixteen. It is not typed by hand, so a colour Catppuccin does not
  place in the sixteen cannot acquire a slot, and a colour it does place cannot
  be given the wrong one. The two flavours disagree about which greys sit in the
  black and white slots, and the lookup follows each of them rather than
  assuming they match.
- The role assignments in `roles()` are werk's, informed by Catppuccin's
  [style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md).

## How the copy is kept honest

`@catppuccin/palette` is a devDependency of this package and of nothing else, at
exactly `1.8.0`. `test/palette.test.ts` imports it and asserts that every hex
here equals the one upstream publishes — all twenty-six colours of both
flavours, and all sixteen ANSI slots of each. A version bump that changes a
value fails that test rather than passing quietly.

The dependency is a devDependency, not a runtime one, because werk needs
eighty-four values and the package carries a great deal more: importing it would
put its colour-space data into the compiled `werk` binary and the browser
bundle for nothing.
