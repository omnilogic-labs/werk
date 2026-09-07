/**
 * The shell scripts are embedded with `with { type: "text" }` so that a compiled
 * binary carries them: werk is shipped as one file and has no directory beside
 * it to read them out of at runtime.
 */
declare module "*.sh" {
  const source: string;
  export default source;
}
