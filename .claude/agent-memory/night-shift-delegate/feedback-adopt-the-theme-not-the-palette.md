---
name: feedback-adopt-the-theme-not-the-palette
description: Adopting a design system means the product visibly wears it; mapping it onto what the host already provides is not adoption
metadata:
  type: feedback
---

When werk adopts a palette or a design system, the product must visibly wear
it. An implementation that maps the palette onto whatever the host already
provides, and so changes nothing on screen, is not an adoption.

Issue #18 adopted Catppuccin by writing ANSI slot numbers instead of the
palette's colours, reasoning that a reader already wearing Catppuccin would see
it anyway. It was coherent and researched, and the owner rejected the result:
"we were supposed to use the THEME, not just the colors", and "we are using zero
of them". On a terminal not already themed, `werk --help` looked exactly as it
had before the palette package existed.

Before calling an adoption done, look at it on a host not already set up for
what you adopted. Unchanged output means it has not happened.

Related: [[reference-chalk-downsamples-to-white]].
