// Probe 3: does terminal.resize() deliver SIGWINCH and a new window size to
// the child, and does a real full-screen program (vim) redraw for it?

import { Collector, deadline, finish, log, waitFor, which } from "./_lib.ts";

const P = "03-sigwinch";
deadline(P, 25_000);

// (a) a shell that traps WINCH and prints the new size
const a = new Collector();
const sh = Bun.spawn(
  [
    "bash",
    "-c",
    'trap \'echo "WINCH:$(stty size)"\' WINCH; echo "START:$(stty size)"; while :; do sleep 0.05; done',
  ],
  { terminal: { cols: 80, rows: 24, data: (_t, d) => a.push(d) } },
);
await waitFor(() => a.text.includes("START:"), 5000);
sh.terminal!.resize(132, 43);
const winch1 = await waitFor(() => a.text.includes("WINCH:43 132"), 3000);
sh.terminal!.resize(100, 30);
const winch2 = await waitFor(() => a.text.includes("WINCH:30 100"), 3000);
log("shell output:", JSON.stringify(a.text.replace(/\r/g, "")));
sh.kill("SIGKILL");
await sh.exited;
sh.terminal!.close();

// (b) vim: count the `~` filler rows and look for a clear/home after resize
const vimPath = which("vim");
let vimRedrew: boolean | null = null;
let vimDetails: Record<string, unknown> = { vim: vimPath };
if (vimPath) {
  const v = new Collector();
  const vim = Bun.spawn(
    [vimPath, "-u", "NONE", "-i", "NONE", "-n", "--not-a-term"],
    {
      terminal: { cols: 80, rows: 24, data: (_t, d) => v.push(d) },
      env: { ...process.env, TERM: "xterm-256color" },
    },
  );
  // vim with --not-a-term still uses the tty for drawing; wait for the first paint
  await waitFor(() => (v.text.match(/~/g) ?? []).length >= 20, 5000);
  const before = (v.text.match(/~/g) ?? []).length;
  v.reset();
  vim.terminal!.resize(120, 40);
  const redrew = await waitFor(
    () => (v.text.match(/~/g) ?? []).length >= 30,
    4000,
  );
  const after = v.text;
  const tildes = (after.match(/~/g) ?? []).length;
  const clear = /\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/.test(after);
  vimRedrew = redrew && clear;
  vimDetails = {
    vim: vimPath,
    tildesBefore: before,
    tildesAfterResize: tildes,
    clearOrCupSeen: clear,
    bytesAfterResize: after.length,
  };
  log("vim:", vimDetails);
  vim.terminal!.write("\x1b:q!\r");
  const quit = await Promise.race([
    vim.exited.then(() => true),
    Bun.sleep(2000).then(() => false),
  ]);
  if (!quit) vim.kill("SIGKILL");
  await vim.exited;
  vim.terminal!.close();
} else {
  log("vim not installed; skipping (b)");
}

const details = {
  winchTo132x43: winch1,
  winchTo100x30: winch2,
  ...vimDetails,
  vimRedrew,
};
if (winch1 && winch2 && vimRedrew !== false) {
  finish(
    P,
    "pass",
    `SIGWINCH delivered with new size${vimRedrew ? "; vim redraws" : " (vim not checked)"}`,
    details,
  );
} else {
  finish(P, "fail", "SIGWINCH not delivered or vim did not redraw", details);
}
