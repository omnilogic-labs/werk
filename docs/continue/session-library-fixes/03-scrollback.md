# 03 Scrollback retention and snapshot sizing

Environment: Bun 1.3.14 on WSL2 (Linux 6.18, 16 GB), engine build
`ghostty-3c1ef5b3`, grid 120x40 unless stated. Every number marked
"pre-reboot" was measured before the machine crashed and could not be
reproduced within the post-reboot caps (10 MB, 30k lines, one live instance);
they are transcribed from the transcript. Everything else was re-measured after
the reboot with one WASM instance alive at a time.

## Summary

- The pinned libghostty build defaults `max_scrollback_bytes` to 10,000
  (upstream `Terminal.zig:272`), but the effective limit is
  `max(explicit, two pages)` and a page is 458,752 bytes (448 KiB). Pruning is
  page granular: retained pages = `floor(limit / 458,752)`, never fewer than
  two. That is why 10,000, 100 KB, 500 KB, 1,000,000 and 1,048,577 all retain
  the same ~650 to 690 rows at 120 cols, and why 1 MB looked like a no-op.
- "Bytes" means page memory (8 bytes per cell plus row headers), not text.
  One page holds 451 rows at 120 cols, 674 at 80, 271 at 200. A 10 MB limit
  keeps 21 pages: about 9,100 to 9,300 rows at 120 cols, roughly 13,500 at 80.
- The snapshot is compact: about one byte per visible character. 10 MB of
  scrollback full of 72-char lines is a 661 KB snapshot (3 ms encode, 9 ms
  restore); the styled worst case (every cell filled, style change every four
  cells) is 4.4 MB (11 ms encode, 19 ms restore). The snapshot header carries
  both explicit limits, so a restored terminal keeps the limit it was encoded
  with, and every history row comes back.
- Recommendation (a lean, not a decision): default and daemon cap of
  10,000,000 bytes, matching Ghostty desktop; an optional `scrollbackBytes` on
  `create` and `restore` in `@werk/terminal`, carried through
  `CreateSessionOptions`, validated and capped in the daemon, reported in
  `SessionInfo` and `DaemonInfo.capabilities`. The envelope does not need a new
  field. A receiver with a lower limit lowers it after decode and the oldest
  pages are pruned immediately.
- Two daemon changes matter more than the number itself: (1) checkpoint only
  dirty, live records (today every record is re-encoded and rewritten every
  5 s, including lost ones) and (2) restore checkpoints lazily at startup. With
  128 retained 10 MB-limit records, eager startup restore measured 8.2 s and
  1.4 GB RSS (pre-reboot); with 5 MB snapshots it was 78 s and 3.2 GB for 40.
- A JSC property shapes all of this: Bun gives the first 8 WASM memories a
  "fast" 4 GiB reservation (`maxNumWasmFastMemories`, 8 with a large gigacage,
  otherwise 3). Memories beyond that copy the whole buffer on every
  `memory.grow`, so growth-heavy work (restore, filling scrollback, snapshot
  encode) slows 6x at 11 MB instances and 50x at 79 MB instances. A 10 MB cap
  keeps instances small enough that the steady-state write path is unaffected.

## Current state (file:line)

- `packages/terminal/src/engine.ts:36-47` `create(size)` takes no options;
  `:118-132` the constructor sets only `CONTINUATION_MAX_BYTES` (1 MiB);
  `:48-106` `restore` sets decoder `MAX_CONTINUATION_BYTES` 1 MiB and
  `RETAIN_CONTINUATION`, refuses snapshots over 64 MiB at `:57-58`, drains
  every history page at `:87-91`; `:235-243` `snapshot()` uses
  `ghostty_snapshot_encode_alloc` (the output buffer is allocated inside WASM
  memory and copied out).
- `packages/terminal/src/types.ts:75-81` `TerminalEngineFactory`, `:5-10`
  `SnapshotEnvelope`, `:38-46` capabilities, `:60-74` `TerminalHandle`.
- `packages/terminal/src/replica.ts:50-56` restores whatever the daemon sent.
- `packages/terminal/README.md:29-30` "Defaults retain upstream's bounded
  scrollback"; `:32-35` the reflow caveat after restore plus resize.
- `packages/session/src/types.ts:56-63` `CreateSessionOptions`; `:36-55`
  `SessionInfo`; `:68-78` `DaemonInfo`. `packages/session/src/index.ts:340`
  `create` passes the options object through unchanged.
- `packages/session-daemon/src/index.ts:47-52,110-123` limits (checkpoint
  interval 5,000 ms, `checkpointMaxBytes` 32 MiB, `maxFrameBytes` 8 MiB);
  `:138-153` `DaemonInfo`; `:227-244` `stateEvent` (falls back to
  `record.checkpoint` when there is no terminal); `:378-431` `checkpoint()`
  (always re-encodes, base64 in JSON, 32 MiB check at `:413`); `:432-480`
  startup loop restoring every record into a live terminal at `:465`;
  `:516-560` create handler, `engineFactory.create(p.size)` at `:552`;
  `:712-720` `readScreen`/`readHistory` need `r.terminal`; `:755-758` attach
  refuses without `r.terminal`; `:875-878` the interval checkpoints every
  record regardless of activity or state.
- `packages/werk/src/main.ts:26` usage, `:91-95` `size()`, `:310-316` create.
  `examples/session-web/src/client.ts:127-132` create.
- Tests: `packages/terminal/test/engine.test.ts`;
  `packages/session-daemon/test/daemon.test.ts:20-75` fake engine with
  `create(size)` and an `allocated()` counter; `hardening.test.ts:258-272`
  wraps `real.create(size)`.
- Upstream at the pinned commit: `Terminal.zig:272` default 10,000;
  `PageList.zig:7022-7062` `minMaxSize` (`(ceil(rows / rows_per_page) + 1) *
item_size`, at least two pages) and `:6958` `exceeded`; `:4020-4030` the
  grow path prunes when `page_size + item_size > max`; `:3951-3977`
  `setMaxBytes`/`setMaxLines` prune immediately when lowered;
  `snapshot/terminal.zig:107-109,123-126` the TERMINAL record stores both
  explicit limits (`0xffffffffffffffff` = unlimited); `PageList.zig:4455-4463`
  a prepended history page that would exceed the receiving limits fails with
  `MaxSizeExceeded`/`MaxLinesExceeded` and `snapshot/history.zig:201-228`
  consumes it with zero rows; `mem.zig:32-60` page compression can reclaim
  memory only on 64-bit Linux and Darwin, so `ghostty_terminal_compress`
  reports `unsupported` on wasm32 (`PageList.zig:4857-4861`).

## Findings

### 1. Units, granularity and the 1 MB no-op

`SCROLLBACK_MAX_BYTES` is the explicit policy; the effective maximum is
`max(explicit, minMaxSize)`. `minMaxSize` is `item_size * (pages_for_active_area

- 1)`, so for any grid whose rows fit one page it is two pages. The page pool
item in this build is 458,752 bytes (found by binary search for the smallest
limit that keeps a third page: 1,376,256, pre-reboot). The grow path prunes the
oldest complete page when `page_size + item_size > max`, so the number of
retained pages is `floor(limit / 458,752)` with a floor of 2:

| limit            | pages | rows at 120 cols (30k-line run) |
| ---------------- | ----- | ------------------------------- |
| 10,000 (default) | 2     | 686                             |
| 100 KB, 500 KB   | 2     | 651 (pre-reboot run)            |
| 1,000,000        | 2     | 686                             |
| 1,048,577        | 2     | 651 (pre-reboot run)            |
| 1,572,864        | 3     | 1,137                           |
| 2,000,000        | 4     | 1,588                           |
| 5,000,000        | 10    | 4,294                           |
| 10,000,000       | 21    | 9,255                           |
| 50,000,000       | 109   | 30,417 (all input; pre-reboot)  |

The retained count moves by up to one page (451 rows at 120 cols) depending on
how full the newest page is, which is the "estimate" the header documents.
Rows per page, from the delta between adjacent page counts (pre-reboot): 451 at
120 cols, 674 at 80 cols, 271 at 200 cols, consistent with roughly 8 bytes per
cell plus a small row header (458,752 / 451 = 1,017 bytes per 120-col row).

`SCROLLBACK_MAX_LINES` behaves the same way with physical rows as the unit and a
floor of one page of rows; both limits apply and the first reached wins.
Passing a NULL value pointer removes a limit (`ghostty_terminal_set` with a
zero pointer). With bytes unlimited and lines 100,000, 300k lines left 99,757
rows and a 130 MB WASM instance (pre-reboot). On wasm32 `size_t` is 32 bits, so
values above 4,294,967,295 cannot be expressed.

The option does not have to be set before output. Raising it later only
affects future growth (686 rows stayed 686 after raising to 10 MB, then grew
to 9,038 with more output); lowering prunes immediately (9,038 to 469 rows at
1 MB). WASM memory never shrinks: the instance stayed at 10.4 MB after the
prune, with the freed pages kept in the pool's free list for reuse.

### 2. Measurement table

Post-reboot, 30k random 72-byte lines (2.15 MB of input), 120x40, one instance
at a time, restore after the source was disposed:

| setting | pages | write ms | MB/s | totalRows | snapshot KB | encode ms | restore ms | restored rows | wasm live MB | wasm restored MB |
| ------- | ----- | -------- | ---- | --------- | ----------- | --------- | ---------- | ------------- | ------------ | ---------------- |
| default | 2     | 9        | 225  | 686       | 50          | 3.8       | 5.3        | 686           | 2.3          | 1.9              |
| 1 MB    | 2     | 4        | 519  | 686       | 50          | 0.7       | 5.8        | 686           | 2.3          | 1.9              |
| 1.5 MiB | 3     | 4        | 502  | 1,137     | 82          | 1.5       | 5.8        | 1,137         | 2.9          | 2.4              |
| 2 MB    | 4     | 6        | 332  | 1,588     | 114         | 0.9       | 6.2        | 1,588         | 3.4          | 2.9              |
| 5 MB    | 10    | 7        | 289  | 4,294     | 307         | 1.1       | 7.2        | 4,294         | 6.5          | 5.9              |
| 10 MB   | 21    | 10       | 210  | 9,255     | 661         | 3.0       | 8.9        | 9,255         | 12.3         | 11.2             |

Pre-reboot, same script shape, 30k lines: 100 KB, 500 KB and 1 MiB+1 matched
the 1 MB row (651 rows, 47 KB); 50 MB retained all 30,417 rows in 2,161 KB
(7.3 ms encode, 20.6 ms restore, 38.9 MB live, 34.8 MB restored, 23 ms write
at 90 MB/s because of growth); lines 100k with bytes unlimited gave the same
rows and bytes (6.7 ms encode, 15.4 ms restore).

Pre-reboot, 300k lines (21.8 MB of input), the only run of that size:

| setting                | totalRows | snapshot KB | encode ms | restore ms | wasm live MB | wasm restored MB | write ms (MB/s) |
| ---------------------- | --------- | ----------- | --------- | ---------- | ------------ | ---------------- | --------------- |
| default to 1 MiB+1     | 537       | 40          | 0.2-2.1   | 5.9-7.2    | 2.2          | 1.9              | 37-49 (420-560) |
| 1.5 MiB                | 988       | 72          | 0.3       | 5.8        | 2.6          | 2.4              | 39              |
| 2 MB                   | 1,439     | 105         | 0.3       | 5.6        | 3.1          | 2.9              | 38              |
| 5 MB                   | 4,145     | 301         | 0.9       | 6.4        | 6.4          | 5.9              | 44              |
| 10 MB                  | 9,106     | 660         | 1.8       | 7.7        | 12.3         | 11.2             | 49              |
| 50 MB                  | 48,343    | 3,498       | 10.6      | 25.0       | 64.4         | 52.4             | 72 (290)        |
| lines 100k, bytes NULL | 99,757    | 7,217       | 17.7      | 47.1       | 130.3        | 106.3            | 94 (221)        |

Restore has a floor of roughly 5 to 8 ms that is instance creation, not
decoding: `create()` alone measured 3.2 ms post-reboot (7.4 ms pre-reboot) for
a 1.4 MB instance, most of it instantiation plus parsing `ghostty_type_json`.

Worst-case snapshot density (post-reboot): 12k full 120-col rows with an SGR
change every four cells at a 10 MB limit kept 9,295 rows and produced a
4,388 KB snapshot (483 bytes per row; 10.7 ms encode, 18.7 ms restore). The
live instance was 25.8 MB rather than 12.3 MB because the encoder's output
buffer lives in WASM memory and the growth is never returned. Its checkpoint
JSON was 5.71 MB (7.0 ms to build, 5.4 ms to parse and base64-decode).

Memory model per terminal, from the table: about 1.4 MB base, plus page memory
up to the limit, plus transient encode output (roughly one to three times the
snapshot) that stays allocated. A restored instance is pages plus a copy of
the snapshot bytes (`a.temporary(s.bytes.length)` in `restore`).

### 3. Snapshot contents and the limits

The snapshot includes every retained history page, not only the continuation:
restored rows equalled source rows in every case above, including 99,757 rows
(pre-reboot). `MAX_CONTINUATION_BYTES` and `RETAIN_CONTINUATION` in
`engine.ts:69-83` govern only the unfinished VT or UTF-8 input carried in the
CONTINUATION record. The TERMINAL record stores both explicit scrollback
limits, so `SCROLLBACK_MAX_BYTES` read from a restored terminal returned the
value the source had (10,000,000, or `NO_VALUE` when unlimited), and writing
2,000 further lines into a restored 10 MB terminal kept it at 9,128 rows.

If the receiving side wants a smaller limit, setting it after decode prunes at
once: restoring the 10 MB snapshot and setting 2 MB went from 9,255 to 1,588
rows, then 1,252 after 100 more lines. Setting a larger limit on restore
changes nothing until new output arrives. The decoder itself only rejects
history pages that would exceed the limits in the header (`MaxSizeExceeded`),
consuming them with zero rows, so a snapshot whose header was lowered by hand
would lose its oldest pages silently rather than fail.

No envelope-versus-terminal size mismatch arises from scrollback: `restore`
compares only `COLS`/`ROWS` (`engine.ts:93-97`) and the grid is independent of
history. The remaining mismatch risk is the existing reflow caveat: a restored
long wrapped line can reflow differently after later output plus a resize,
and a larger history means more rows subject to that. Not measured here.

### 4. Held instances: the JSC fast-memory cliff (pre-reboot)

Holding many restored instances in one Bun process:

| snapshot                                           | instances 1-8 restore | instances 9+ restore | total, RSS                                |
| -------------------------------------------------- | --------------------- | -------------------- | ----------------------------------------- |
| 0.65 MB (10 MB limit, 9.3k rows, 11.1 MB instance) | 10-13 ms              | 55-95 ms             | 128 held: 8.2 s, +1,435 MB (11.2 MB each) |
| 5.0 MB (72k rows, unlimited, 79 MB instance)       | 35-53 ms              | 2,300-2,700 ms       | 40 held: 78 s, +3,162 MB (79 MB each)     |

With 40 large instances held, writing 30k lines into an instance still growing
ran at 1 MB/s and `snapshot()` took 272 ms; with 128 small instances at their
limit (no growth), writing ran at 107 MB/s and `snapshot()` took 23 ms
(2.4 ms in fast mode). A raw test growing a bare instance to 64 MB in 448 KiB
steps took under 1 ms for instances 1 to 8 and 1.8 to 2.4 s for instances 9 to 16. Decode stages for the 5 MB snapshot in slow mode: copy-in 9.9 ms, READY
25.2 ms, then 159 history pages in 2,343 ms (14.7 ms per page, one buffer copy
per page allocation).

WebKit's `OptionsList.h` explains it: `maxNumWasmFastMemories` defaults to 8
(3 without a large gigacage); those memories get a 4 GiB virtual reservation
and grow in place, later ones are bounds-checked and reallocated on grow. Bun
accepts `BUN_JSC_` overrides but labels them unstable; the name to try is
`BUN_JSC_maxNumWasmFastMemories`. Not tested (it needs many live instances).
The practical reading: keep per-session WASM memory small and avoid repeated
growth. At a 10 MB cap the slow mode costs about 6x on restore and encode and
nothing on steady-state writes.

### 5. Checkpoint loop today

`index.ts:875-878` schedules `checkpoint(r)` for every record every 5 s;
`checkpoint()` re-encodes whenever a terminal exists, including records that
were restored at startup and can never change, and rewrites the file. At 100
sessions at the 10 MB cap that is 100 encodes (2.4 ms fast, 23 ms slow) and up
to 66 MB (plain) or 440 MB (styled worst case) of JSON written per 5 s if all
are full, whether or not anything happened.

### 6. CURSOR_AT_PROMPT and PROGRESS_REPORT (bonus)

`CURSOR_AT_PROMPT` reads the OSC 133 semantic state (post-reboot):

| after                                 | at_prompt |
| ------------------------------------- | --------- |
| fresh terminal                        | false     |
| OSC 133;A (prompt start) and prompt   | true      |
| OSC 133;B (input start), echoed input | true      |
| OSC 133;C (output start), output      | false     |
| OSC 133;D (command end)               | false     |
| OSC 133;A again                       | true      |
| alternate screen on                   | false     |
| alternate screen off                  | true      |
| after snapshot and restore            | true      |

No effect fires on a transition; the engine would poll one
`ghostty_terminal_get` after each `write` (microseconds) and emit a synthetic
`{ kind: "prompt", payload: boolean }` when it changes. It is a "shell is
idle at a prompt" signal, which needs shell integration in the session's shell
and is false while a TUI such as a coding agent owns the screen. So it looks
more like an "idle" indicator than "needs you"; "needs you" probably still
comes from `bell`, `notification` (both already effects) and whatever the agent
emits. `PROGRESS_REPORT` (OSC 9;4) already arrives as the `progress` effect
(`engine.ts:146-150`, payload `{ state, progress }`) and the daemon already
stores `lastEffect`; surfacing it as a `SessionInfo.progress` field is a daemon
change only. Which agents emit OSC 9;4 or OSC 133 is not established.

## Recommendation

Default: a lean towards `scrollbackBytes = 10,000,000` (Ghostty desktop's
default), giving about 9,100 to 9,300 rows at 120 cols and about 13,500 at 80,
at up to ~11 MB of WASM memory per session (only when filled; an idle shell
sits at ~2.3 MB) and a snapshot of 0.66 MB typical, 4.4 MB worst case. 5 MB
would halve memory for roughly 4,300 rows at 120 cols; the promise
"scrollback included" and the fact that memory is only consumed when used
argue for 10 MB. The daemon should always pass an explicit value; whether
`@werk/terminal`'s own default should move from upstream's 10,000 to the
same 10 MB is open (the lean is to leave the engine at upstream's default so
the README statement stays true, and let consumers choose).

API in `@werk/terminal`:

- `TerminalOptions { scrollbackBytes?: number }` with integer 0 to
  4,294,967,295 (0 disables scrollback; larger values are a `RangeError` on
  wasm32). `create(size, options?)` sets `SCROLLBACK_MAX_BYTES` right after
  `ghostty_terminal_new`; `restore(envelope, options?)` applies it after the
  history drain, which prunes when lower and permits growth when higher.
- `TerminalHandle.scrollback(): { maxBytes: number | null; rows: number }`
  from `SCROLLBACK_MAX_BYTES` (`NO_VALUE` as null) and `SCROLLBACK_ROWS`, so a
  UI can say "9,255 lines of scrollback". `capabilities.scrollbackLimit: true`.
- The pre-existing 64 MiB refusal in `restore` stays; at a 10 MB cap the worst
  case is 4.4 MB.

Envelope: no new field. The snapshot header already carries the explicit
limits, so a restored terminal (daemon at startup, browser replica) keeps them.
Adding `scrollbackBytes` to `SnapshotEnvelope` would duplicate the header; the
policy belongs on `SessionInfo` instead.

`@werk/session`: `CreateSessionOptions.scrollbackBytes?: number`,
`SessionInfo.scrollbackBytes: number`, `DaemonInfo.capabilities.scrollbackMaxBytes`.

Daemon cap: `limits.scrollbackMaxBytes` (default 10,000,000). A request above
it is a `LIMIT` error rather than a silent clamp; a missing value takes the
cap. On startup, restore with `{ scrollbackBytes: min(saved, cap) }` so a
lowered configuration takes effect on retained records. Restore of a snapshot
larger than the receiver's limit is therefore: decode everything, then prune
the oldest pages to the receiver's limit, page granular.

Wire and preview: with the binary frame (1.0x on the wire, sub-millisecond
encode) a snapshot costs its weight on every attach and resync: 0.66 MB
typical, 4.4 MB worst at the 10 MB cap, well under `maxFrameBytes` 8 MiB. The
preview representation uses formatted text frames and is unaffected. If a
slow link ever matters, the decoder's READY stage (25 ms in the slow-mode
measurement above) would let a client paint before history arrives, but the
current framing sends one snapshot frame; not proposed here.

## Startup and checkpoint implications

Eager restore at startup (`index.ts:432-480`) with 100 retained records at the
10 MB cap would be roughly 6.5 s and 1.1 GB RSS (128 measured: 8.2 s, 1.4 GB,
pre-reboot), and it only gets worse past the eighth instance because of the
fast-memory limit. Every record at startup is `lost` or `exited`, so no live
terminal is needed until someone looks. Lazy restore is warranted:

- Keep `record.checkpoint` bytes; validate cheaply (engine build, format
  version, the `GHOSTSNP` magic, size under the cap) and report
  `checkpoint.decodable` from that check, with a full decode deferred.
- `attach` to a record without a terminal sends `record.checkpoint` directly
  (`stateEvent` already falls back to it at `:228`); only the guard at
  `:757` needs `!r.terminal && !r.checkpoint`. The client decodes.
- `readScreen`/`readHistory` restore on demand, and a terminal restored this
  way can be disposed after an idle period (WASM memory is only reclaimed when
  the instance is unreachable, so disposal plus dropping the handle is what
  frees the 11 MB).
- Records with a live process are unaffected: they are created, not restored.

Checkpoint loop: checkpoint only records whose `position`, size or state has
changed since the last successful write, plus once on exit and at shutdown;
never re-encode a record without a child once its post-exit checkpoint exists.
This removes the idle cost entirely and bounds the busy cost to sessions that
actually produced output in the last 5 s.

`checkpointMaxBytes` 32 MiB is comfortable at a 10 MB cap (worst-case JSON
5.7 MB). It binds only when a snapshot approaches 24 MB, which the styled
worst case would reach near a 50 MB cap; raising the cap later means raising
this limit with it, or moving the checkpoint file to the same header-plus-raw
layout as the wire frame (removes base64's 33% and the JSON parse; speculative).

Memory budget: 128 sessions all at the cap is about 1.4 GB of WASM memory in
one process, none of it reclaimable while the sessions live (page compression
is unsupported on wasm32). Whether the daemon wants a process-wide budget
(`limits.scrollbackTotalBytes`, lowering per-session limits when it is
reached) is an open question; the numbers say the per-session cap alone does
not bound the process.

## Implementation plan

1. `packages/terminal/src/types.ts`: `TerminalOptions`, `scrollback()` on
   `TerminalHandle`, `create(size, options?)`, `restore(snapshot, options?)`,
   `capabilities.scrollbackLimit`. (0.5 h)
2. `packages/terminal/src/engine.ts`: validate and set `SCROLLBACK_MAX_BYTES`
   in the constructor when given; apply the option after the history drain in
   `restore`; implement `scrollback()` (read `SCROLLBACK_MAX_BYTES` tolerating
   `NO_VALUE`, read `SCROLLBACK_ROWS`). (1.5 h)
3. `packages/terminal/test/engine.test.ts`: default and 1 MB retain the same
   rows (two-page floor); 10 MB retains more than 5,000 of 30k lines at 120
   cols; snapshot restores rows and limit; `restore` with a lower option prunes
   at once; `scrollback()` reports; 0 disables; out-of-range throws. Keep the
   test under a few MB so CI memory stays flat. (1.5 h)
4. `packages/terminal/README.md`: replace the "upstream's bounded scrollback"
   sentence with the option, the two-page floor (~0.9 MB) and page granularity
   (~450 KB, ~450 rows at 120 cols). (0.5 h)
5. `packages/session/src/types.ts` and `packages/session/README.md`: the three
   new fields. (0.5 h)
6. `packages/session-daemon/src/index.ts`: `limits.scrollbackMaxBytes`;
   validate `p.scrollbackBytes` in the create handler (`:516-560`), pass to
   `engineFactory.create`, store on `info`, expose in capabilities (`:146`);
   pass `min(saved, cap)` on startup restore (`:465`). Tests in
   `daemon.test.ts` (fake engine accepts and records options; above-cap
   request is `LIMIT`; `SessionInfo` and `DaemonInfo` carry the values;
   restart with a lower cap passes it to `restore`) and the wrapper signature
   in `hardening.test.ts:265`. (3 h)
7. Checkpoint dirtiness in `checkpoint()` and the interval (`:378-431,
875-878`): test that an idle running session does not rewrite its file
   (mtime), that output does, that exit writes once, and that a restored lost
   record is never rewritten. (2 h)
8. Lazy startup restore (`:432-480`, attach guard `:757`, `readScreen`/
   `readHistory` `:712-720`, idle disposal): tests that startup with N records
   allocates no terminals (the fake engine's `allocated()` counter), attach to
   a lost record delivers the checkpoint, `readHistory` restores on demand,
   and an undecodable checkpoint still reports `decodable: false`. (4 h)
9. `packages/werk/src/main.ts`: `--scrollback BYTES` on create (`:26, :310`);
   `examples/session-web` optional. (1 h)
10. Docs: `docs/session-library.md` operational note on the cap and startup
    behaviour; `packages/session-daemon/README.md:21-25`; an open question in
    `docs/product/04-open-questions.md` on a process-wide scrollback budget
    and retention. (1 h)
11. Optional: `prompt` effect and `SessionInfo.atPrompt`/`progress` (engine
    poll after write, daemon field, test with OSC 133 and OSC 9;4). (2 h)

## Risks and open questions

- Process memory: the per-session cap does not bound the daemon; 128 full
  sessions is ~1.4 GB and page compression cannot help on wasm32. A budget
  is an open question.
- The JSC fast-memory limit (8) means the ninth and later sessions pay 6x on
  restore and encode at the 10 MB cap, and far more for larger instances. The
  `BUN_JSC_maxNumWasmFastMemories` override is unstable API and untested;
  each fast memory reserves 4 GiB of address space, which containers with
  address-space limits may refuse.
- The measurements are from one WSL2 machine on Bun 1.3.14. The held-instance
  experiments used up to 3.2 GB RSS and may have contributed to the crash that
  interrupted this work alongside five other agents' runs; the daemon soak
  budgets in `docs/session-library.md` (peak RSS at most twice the 191 MB
  baseline) will move once sessions can hold 11 MB each.
- Retained rows fluctuate by up to one page (~451 rows at 120 cols) and the
  unit is page memory, so "10 MB" is not a text size. The UI should show
  rows from `scrollback()` rather than the byte figure.
- wasm32 `size_t` is 32-bit: values above 4 GiB are unrepresentable and must
  be rejected in the engine.
- Snapshot format v1 carries no compatibility guarantee; the limit fields in
  the header are part of the pinned build's behaviour and should be covered
  by the asset-upgrade validation.
- Reflow on resize with a large history is unmeasured; the README caveat
  stands and a bigger history makes it more visible.
- Real-world snapshot sizes for TUI-heavy sessions are unknown; the styled
  worst case (483 bytes per row) bounds them at ~4.4 MB for a 10 MB cap.
- Which agents emit OSC 133 or OSC 9;4 is not established, so the bonus
  signals may be of limited use for "needs you".

## Effort

Core (steps 1 to 7): about 10 hours. Lazy restore (8): 4 hours. CLI and
docs (9, 10): 2 hours. Bonus (11): 2 hours. Total 16 to 18 hours, with the
daemon tests being the least certain part.
