/** Native shell inputs encode marker text so echoed commands cannot satisfy output assertions. */
export const shellArgv = ["/bin/sh"];
export function printCommand(text: string): string {
  const octal = Array.from(
    new TextEncoder().encode(text),
    (byte) => "\\" + byte.toString(8).padStart(3, "0"),
  ).join("");
  return `printf '${octal}'\n`;
}
export function floodCommand(): string {
  return (
    "head -c 150000 /dev/zero | tr '\\000' x; " +
    printCommand("\nfinished-stream\n")
  );
}
export function endpointCredential(endpoint: {
  kind: string;
  credential?: string;
}) {
  return endpoint.kind === "tcp" ? endpoint.credential : undefined;
}
