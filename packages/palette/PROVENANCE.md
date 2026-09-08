# Where these colours came from

The palette is [Catppuccin](https://github.com/catppuccin/catppuccin), MIT
licensed, copyright (c) 2021 Catppuccin. `LICENSE.catppuccin` is the upstream
notice, kept here because the hex values in `src/index.ts` are copied from it.

## What was copied

From `@catppuccin/palette` version **1.8.0**, which publishes
[`palette.json`](https://github.com/catppuccin/palette/blob/main/palette.json):

- The twenty-six named colours — the fourteen accents and the twelve-step
  monochromatic ramp — of all four flavours, `latte`, `frappe`, `macchiato` and
  `mocha`, each as its `hex`.
- The sixteen ANSI colours of each flavour, from that flavour's `ansiColors`,
  ordered by the `code` upstream gives them: the eight `normal` entries at slots
  0-7 and the eight `bright` entries at slots 8-15.
- Which colours are accents. Upstream flags each colour with `accent`, and
  `ACCENTS` is that list rather than a second reading of it.

Nothing else in the upstream package is used: `rgb`, `hsl` and `oklch` are not
copied, and `rgb` here is derived from the hex.

## What is derived rather than copied

- `Swatch.rgb` is the hex parsed to a packed integer, for the renderer.
- `Swatch.ansi` is the slot found by looking the colour's hex up in its own
  flavour's sixteen. It is not typed by hand, so a colour Catppuccin does not
  place in the sixteen cannot acquire a slot, and a colour it does place cannot
  be given the wrong one. Latte disagrees with the three dark flavours about
  which greys sit in the black and white slots, and the lookup follows each
  flavour rather than assuming they match.
- The role assignments in `roles()` are werk's, informed by Catppuccin's
  [style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md).

## What is werk's alone

`fallbackSlot` is werk's table and nothing upstream backs it.

Catppuccin places six of the fourteen accents in the sixteen a terminal theme
defines: red, green, yellow and blue at slots 1 to 4, pink at 5 because magenta
is Pink rather than Mauve, and teal at 6 because cyan is Teal rather than Sky.
Those six are read out of `ansiColors` and asserted against it. Peach and
Rosewater it places at 16 and 17, which are outside the sixteen. The remaining
six — mauve, lavender, sapphire, sky, maroon and flamingo — it places nowhere.

So werk assigns the eight it is not given, by nearest hue: mauve and rosewater
to 5, maroon and flamingo to 1, peach to 3, sky and sapphire to 6, and lavender
to 4.

Catppuccin has no position on this. Its ports do not degrade at all: they
require 24-bit colour and several name the terminals they will not work on.
What werk shows a reader who has sixteen colours is werk's own decision,
and `test/palette.test.ts` holds the eight in a table of their own so that
moving one is a deliberate edit.

## How the copy is kept honest

`@catppuccin/palette` is a devDependency of this package and of nothing else, at
exactly `1.8.0`. `test/palette.test.ts` imports it and asserts that every hex
here equals the one upstream publishes — all twenty-six colours of all four
flavours, all sixteen ANSI slots of each, and the fourteen accents. A version
bump that changes a value fails that test rather than passing quietly.

The dependency is a devDependency, not a runtime one, because werk needs a
hundred and sixty-eight values and the package carries a great deal more:
importing it would put its colour-space data into the compiled `werk` binary and
the browser bundle for nothing.
