for (const name of [
  "terminal",
  "session",
  "terminal-beamterm",
  "session-daemon",
  "workspace",
  "werk",
]) {
  const child = Bun.spawn(
    [
      process.execPath,
      `packages/${name}/node_modules/typescript/bin/tsc`,
      "-p",
      `packages/${name}/tsconfig.json`,
      "--noEmit",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Typecheck failed: ${name}`);
}
