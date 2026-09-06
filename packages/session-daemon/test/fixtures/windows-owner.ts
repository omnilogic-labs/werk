import { spawnPty } from "../../src/platform/index.js";
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
const script = `const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{detached:true,stdio:["ignore","ignore","ignore"]});console.log("OWNED_DESCENDANT="+child.pid);setInterval(()=>{},1000);`;
spawnPty(
  [process.execPath, "-e", script],
  process.cwd(),
  environment,
  { cols: 80, rows: 24 },
  (bytes) => process.stdout.write(bytes),
);
setInterval(() => {}, 1000);
