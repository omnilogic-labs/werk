---
name: feedback-adopt-the-theme-not-the-palette
description: Adopting a design system means the product visibly wears it; borrowing the reader's equivalent colour is not adoption. Rejected once on Catppuccin in issue #18.
metadata:
  type: feedback
---

When werk adopts a palette or a design system, the product must visibly wear it.
An implementation that maps the palette onto whatever the host already provides
and therefore changes nothing on screen is not an adoption, however defensible
the reasoning.

**Why:** issue #18 adopted Catppuccin by writing ANSI slot numbers instead of the
palette's colours, reasoning that a reader whose terminal already wore Catppuccin
would see it anyway and a reader wearing something else kept the contrast they
chose. It was internally coherent, it was researched, and the owner rejected the
result: "we were supposed to use the THEME, not just the colors", and "we are
using zero of them". On a terminal not already themed, `werk --help` looked
exactly as it had before the palette package existed.

Two smaller shapes of the same mistake were called out in the same breath, and
both are worth checking for directly:

- **A choice fixed at module load is not a choice.** `export const dark =
roles("mocha")` made the flavour a build-time constant, and `light` was
  exported, tested, and wired to nothing.
- **A setting that is settable and inert.** `WerkConfig.colour` existed, was
  documented and was tested, and nothing consumed it.

**How to apply:** before calling an adoption done, run the thing and look at it
on a host that is _not_ already set up for what you adopted. If the output is
byte-identical to what it was before, the adoption has not happened. Then grep
the new surface for exports and config keys nothing reads: those are the same
defect in miniature and the owner notices them.

Related: [[reference-chalk-downsamples-to-white]].
