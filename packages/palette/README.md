# @werk/palette

The colours werk uses, and what it uses them for. One place, so that anywhere
werk puts colour on a screen asks for a role rather than naming a colour.

The palette is [Catppuccin](https://github.com/catppuccin/catppuccin), in all
four of its flavours. [PROVENANCE.md](PROVENANCE.md) says where the values came
from, which of them are werk's rather than Catppuccin's, and how the copy is
kept honest.

```ts
import { roles, cssVariables } from "@werk/palette";

const theme = roles("mocha", "mauve");
theme.error.hex; // "#f38ba8"
theme.error.ansi; // 1
theme.accent.hex; // "#cba6f7"
theme.terminal.background.rgb; // 0x1e1e2e
cssVariables(theme); // ":root{--werk-flavour:mocha;…}"
```

## A flavour and an accent

Catppuccin's model is a flavour plus an accent, and `roles(flavour, accent)`
composes the two. The flavour is Latte, Frappé, Macchiato or Mocha, and it
decides the ground and the twelve-step ramp of greys above it. The accent is one
of the fourteen chromatic colours, and it marks what the reader should look at.

This package never chooses a colour scheme. There is no `dark` and no `light`
export, because a flavour fixed when the module loads is one nothing can choose
afterwards. `defaultRoles` is Mocha with a mauve accent and exists to be a
default argument. Who picks, and how, belongs to the consumer: the CLI resolves
it from its configuration and, where it can, from the terminal's own
background.

The accent reaches `accent`, `borderActive` and `heading`. It reaches nothing
that carries meaning, so an error is red and a success is green whatever accent
is chosen. That is what every Catppuccin port does, and it is what keeps the
output readable when somebody picks red.

## Roles

A role is a use, not a colour: `error`, `heading`, `border`,
`terminal.background`. The assignments follow Catppuccin's own
[style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md)
where it has an opinion — Base is the page, Text is body copy, Green is success,
Yellow is a warning, Red is an error, Blue is a link, Rosewater is a cursor,
Overlay 2 is a selection — and werk's reading where it does not.

## Three forms, because three kinds of consumer need different ones

A `Swatch` carries the same colour three ways, and which one a surface reads
says something about that surface.

| Field  | For                                                   |
| ------ | ----------------------------------------------------- |
| `hex`  | A page that owns its own pixels                       |
| `rgb`  | The replica, which carries colour as a packed integer |
| `ansi` | A terminal with sixteen colours, where it has a slot  |

The first two are what most consumers want. The third is for the case where werk
is a guest: a terminal that cannot render 24-bit colour can still be told a hue,
and Catppuccin publishes which of its colours sits in each of the sixteen a
terminal theme defines. The slot is looked up in the flavour's own sixteen rather
than typed by hand, so a colour Catppuccin does not place there cannot acquire
one by a typo, and Latte disagrees with the three dark flavours about the black
and white ends of the ramp.

Only six of the fourteen accents have a slot upstream, so `fallbackSlot` covers
the rest. That table is werk's own and PROVENANCE.md says why.
