for (const name of [
  "palette",
  "terminal",
  "session",
  "terminal-beamterm",
  "session-daemon",
  "workspace",
  "mapper",
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

// The scripts are typechecked too, against their own tsconfig, because they are
// the only consumers of the built packages that nothing else compiles. The soak
// reached CI calling `createSessionDaemon` without a `version` it had just been
// given a required field for, and no lane before this one would have said so.
{
  const child = Bun.spawn(
    [
      process.execPath,
      "packages/werk/node_modules/typescript/bin/tsc",
      "-p",
      "tsconfig.scripts.json",
      "--noEmit",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error("Typecheck failed: scripts");
}
