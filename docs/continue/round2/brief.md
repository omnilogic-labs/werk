# werk — what it is

You are pitching this product. Read this, then make your own decisions about
everything else.

## The product

**werk starts a process somewhere and lets you come back to it later.**

Locally, on a machine you can ssh to, or in a container it provisions. It puts
your repository there on a fresh branch, gives you a terminal that survives your
laptop closing, and shows you every one of those — across every machine — in one
list you can open from a terminal or a browser.

You tell it where work should run: the Mac mini on the desk, a VPS, a container
it provisions, the company Kubernetes cluster. You dispatch from your own
terminal. You monitor everything on one list. The commits come back.

The two universal interfaces to a repository, for humans and for agents alike,
are the terminal and git. werk is about making both trivially easy to reach.

**Coding agents are the workload that matters.** They happen to be command-line
programs — Claude Code, Codex, Gemini CLI, Aider — so werk dispatches and
monitors them with no per-agent integration and no plugin for each one. An agent
released next month works on the day you install it. werk reads the signals any
well-behaved terminal program already emits: the bell, OSC 9 and 777
notifications, OSC 9;4 progress, OSC 133 command boundaries and exit status.

### Where you get at it

- **Your terminal.** Bare `werk` prints the fleet and exits, like `ls` or
  `git status`. `werk attach <name>` puts you inside a session. There is a TUI
  for steering the fleet without leaving the terminal.
- **A browser.** `werk serve` runs locally and gives you the same thing as a web
  app: every session on every machine, and you can type into any of them.

### What exists today, and what does not

Working now: the terminal, the CLI, the TUI, and `werk serve` in a browser on
your own network.

Planned, not built: a hosted version so the same view reaches you from a phone
or another continent; handing a colleague a live link to one of your terminals;
and a company-wide view where you can see every agent session in the
organisation — each person, the sessions they are running, and the subagents
those sessions have spawned — and open any one of them onto its live terminal.

## Your job

Build and publish a pitch page for werk. One page, an Artifact, yours to shape.

**Generate the imagery with `art`.** Two kinds, and you need both:

- **Images of the product** — werk in use, screens on, work visibly happening.
- **Decorative and atmospheric images** — whatever your concept wants.

```bash
ART=/home/mike/Development/is4co/agent-skills/plugins/artistic-vision/skills/artistic-vision/bin/art
"$ART" generate out/x.png "<prose scene>" --aspect 16:9 --size 2K --attempts 3 --judge "<what good looks like>"
"$ART" generate out/y.png "<prose scene>" --ref out/x.png --aspect 16:9 --size 2K   # sibling, matches style
"$ART" ocr out/x.png --plain        # stray type check
"$ART" describe out/x.png           # what it actually produced
/home/mike/Development/omnilogic-labs/werk/docs/continue/tools/dataurl.sh out/x.png 1400 160
```

`dataurl.sh` writes `out/x.webp` and `out/x.datauri.txt`; paste the `.txt`
contents into a `src=""`. Asset upload is unavailable on this account, so images
are data URIs. Keep the page under 16MB. Six to ten images is not too many.

`art` garbles small text, so don't build an image around type being readable.
Where a real workspace or branch name must be readable, build that bit in HTML.

## Required

1. **Be accurate about what exists and what is planned.** Don't present the
   unbuilt as shipped. Invent no statistics, customers or certifications.
2. **Pitch it.** This argues for werk to an internal audience. No pre-emptive
   objections, no hedging about who it isn't for, no arguing against yourself.
3. **British spelling**; no "just", "simply", "seamless", "effortless".
4. **Publish and return the URL.** First publish, so pass a `favicon` (one or two
   emoji you choose) and put a `<title>` at the top of the file. Load the
   `artifact-design` skill before writing markup.

Everything else — structure, length, tone, typography, palette, what to lead
with, what to leave out, what the page is even called — is yours. There is no
house style and no template. Nobody wants to read a font stack on a pitch page.

Return a URL and no more than six lines.
