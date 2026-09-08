---
name: feedback-adopt-the-theme-not-the-palette
description: An adoption is done only when the output changes on a host with default settings; check it there before calling it done
metadata:
  type: feedback
---

An adoption of a palette or a design system is done only when the output changes
on a host with default settings. Look at it there before calling it done.
Unchanged output means the adoption has not happened.

Issue #18 adopted Catppuccin by writing ANSI slot numbers instead of the
palette's colours, reasoning that a reader already wearing Catppuccin would see
it anyway. It was coherent and researched, and the owner rejected the result:
"we were supposed to use the THEME, not just the colors", and "we are using zero
of them". On a terminal not already themed, `werk --help` looked exactly as it
had before the palette package existed.

Related: [[reference-chalk-downsamples-to-white]].
