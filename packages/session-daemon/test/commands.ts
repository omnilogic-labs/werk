/** Native shell inputs encode marker text so echoed commands cannot satisfy output assertions. */
export const shellArgv =
  process.platform === "win32"
    ? ["powershell.exe", "-NoLogo", "-NoProfile"]
    : ["/bin/sh"];
export function printCommand(text: string): string {
  if (process.platform === "win32") {
    const encoded = Buffer.from(text).toString("base64");
    return `[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\r`;
  }
  const octal = Array.from(
    new TextEncoder().encode(text),
    (byte) => "\\" + byte.toString(8).padStart(3, "0"),
  ).join("");
  return `printf '${octal}'\n`;
}
export function floodCommand(): string {
  return process.platform === "win32"
    ? `[Console]::Write(('x'*150000))\r` + printCommand("\nfinished-stream\n")
    : "head -c 150000 /dev/zero | tr '\\000' x; " +
        printCommand("\nfinished-stream\n");
}
export function endpointCredential(endpoint: {
  kind: string;
  credential?: string;
}) {
  return endpoint.kind === "tcp" ? endpoint.credential : undefined;
}
