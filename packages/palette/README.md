# @werk/palette

The colours werk uses, and what it uses them for. One place, so that anywhere
werk puts colour on a screen asks for a role rather than naming a colour.

The palette is [Catppuccin](https://github.com/catppuccin/catppuccin), in two
flavours: Mocha where the ground is dark and Latte where it is light.
[PROVENANCE.md](PROVENANCE.md) says where the values came from and how the copy
is kept honest.

```ts
import { dark, cssVariables } from "@werk/palette";

dark.error.hex; // "#f38ba8"
dark.error.ansi; // 1
dark.terminal.background.rgb; // 0x1e1e2e
cssVariables(dark); // ":root{--werk-background:#1e1e2e;…}"
```

## Roles

A role is a use, not a colour: `error`, `heading`, `border`,
`terminal.background`. The assignments follow Catppuccin's own
[style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md)
where it has an opinion — Base is the page, Text is body copy, Green is success,
Yellow is a warning, Red is an error, Blue is a link, Rosewater is a cursor,
Overlay 2 is a selection — and werk's reading where it does not.

## Three forms, because the surfaces are not alike

A `Swatch` carries the same colour three ways, and which one a surface reads
says something about that surface.

| Field  | For                                                      |
| ------ | -------------------------------------------------------- |
| `hex`  | A page that owns its own pixels                          |
| `rgb`  | The replica, which carries colour as a packed integer    |
| `ansi` | A guest on somebody else's terminal, where it has a slot |

Catppuccin publishes both halves: the colours, and which of them sits in each of
the sixteen slots a terminal theme defines. Green is slot 2, teal is 6, red is
1, yellow is 3. So a terminal already wearing Catppuccin has been told what
green means, and a program writing SGR 32 on it gets exactly the green below
without pinning it — while a reader wearing something else keeps the green they
chose. That is why werk's own output goes out as slots and the surfaces with no
theme to inherit go out as hex.

`AnsiSwatch` is the type that demands a slot. A role typed that way cannot be
given lavender, which has none. The slot itself is looked up in the flavour's
own sixteen rather than typed by hand, and the two flavours disagree about which
greys sit in the black and white slots, so the lookup follows each of them.
