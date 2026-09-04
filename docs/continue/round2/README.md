# Round two — four pitch pages

Four independent pitch pages for werk, built from a deliberately thin brief.
Round one produced four pages with one skeleton and four palettes; this round
cut the brief down to the product facts plus a one-line seed per page, and left
structure, tone, typography and page shape entirely to each author.

| Seed           | Page                         | URL                                                                  |
| -------------- | ---------------------------- | -------------------------------------------------------------------- |
| Field manual   | werk Field Manual, Form WK-1 | https://claude.ai/code/artifact/e883c92b-1987-4b19-8951-2d08cba5507d |
| Night shift    | werk night shift             | https://claude.ai/code/artifact/d0b41a4c-ea53-4dcf-97e1-56dfcaa3365a |
| Broadsheet     | The Werk Dispatch            | https://claude.ai/code/artifact/86cc2260-fa3d-4867-9a4d-5ab05cc03f2b |
| Heavy industry | Werk Machine Hall            | https://claude.ai/code/artifact/783e89a9-50d8-474d-b0d2-f5573d0fe547 |

## What they were asked for

`brief.md` is the whole brief — product facts, four requirements, and an
explicit statement that everything else is the author's decision. `spine.md` is
the three things every page had to land:

1. Starting out on your own — dispatch, shut the lid, come back to the session.
2. Sharing a terminal — a live link handed to a colleague.
3. The company-wide view — every person, their sessions, the subagents those
   sessions spawned, and opening any one onto its live terminal.

The first exists today; the other two are planned and not built. Each page found
its own way to mark that split: stamps in a margin rail, a clock that only runs
on shipped features, riveted maker's plates, and section tags plus a ledger.

## The imagery

Thirty-three images, generated with `art`, eight or nine per page. Each page's
set grew from one judged anchor image passed to its siblings with `--ref`, so a
page reads as one shoot rather than eight unrelated renders.

Both kinds were required and both were checked: images of the product in use —
a lit screen with content, someone using it — and atmospheric plates. Verified
per file with `art describe` rather than trusting the author's summary, because
an earlier round returned "product" images that were empty rooms and closed
laptops. Anything needing a readable workspace, branch or host name is built in
HTML, not generated.

## Rebuilding a page

`page.tpl.html` is the published page with each image replaced by an
`{{IMAGE_NAME}}` token; `img/` holds the WebP files those tokens name. To
rebuild, substitute each token with `data:image/webp;base64,<base64 of
img/<name>.webp>` and publish the result to that page's existing URL.
