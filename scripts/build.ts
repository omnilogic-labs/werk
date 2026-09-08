const packages = [
  "palette",
  "terminal",
  "session",
  "terminal-beamterm",
  "session-daemon",
  "workspace",
  "werk",
];
for (const name of packages) {
  const child = Bun.spawn(
    [process.execPath, "run", "--cwd", `packages/${name}`, "build"],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Build failed: ${name}`);
}
const browser = Bun.spawn(
  [process.execPath, "run", "--cwd", "examples/session-web", "build"],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await browser.exited) !== 0) throw new Error("Browser build failed");
