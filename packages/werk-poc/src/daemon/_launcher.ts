// A launcher that leaves: autostarts a daemon in the runtime directory named
// on the command line, prints the daemon's pid, and exits. `launch.test.ts`
// runs this as a process of its own, so that "the launcher can leave" is
// something that happens — the process is gone and the daemon still answers
// — rather than a session id read off the daemon with `ps`, which Windows
// has no equivalent of.

import { connect } from "../client/index.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun run _launcher.ts <runtime dir>");
  process.exit(2);
}
const client = await connect({ dir });
console.log(client.daemon.pid);
client.close();
