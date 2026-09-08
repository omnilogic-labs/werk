import { startWebBridge } from "./bridge.js";
import type { LocalEndpoint } from "@werk/session-daemon";
const endpointPath = Bun.argv[2];
if (!endpointPath)
  throw new Error(
    "Usage: bun dist/server.js /absolute/runtime/endpoint.json [port]",
  );
const endpoint = (await Bun.file(endpointPath).json()) as LocalEndpoint;
const bridge = await startWebBridge({
  endpoint,
  port: Number(Bun.argv[3] ?? 4319),
  assetsDir: import.meta.dir,
});
console.log(`Session browser: http://127.0.0.1:${bridge.port}`);
process.on("SIGINT", () => {
  bridge.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  bridge.stop();
  process.exit(0);
});
