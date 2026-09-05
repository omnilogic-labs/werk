# werk — proposals

Technical specifications for things we are proposing to build. Distinct from
[`../product/`](../product/), which is what werk does, and
[`../research/`](../research/), which is what we found out.

A proposal is allowed to be prescriptive about the thing it proposes, and
nothing else. It does not settle product questions by implication.

| Doc                                                          | What it proposes                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [00-stack-proof-of-concept.md](00-stack-proof-of-concept.md) | A detachable process runner, kept as reference material, built to find out whether TypeScript on Bun with libghostty-vt via upstream's WebAssembly build survives contact. Built in [`../../packages/werk-poc/`](../../packages/werk-poc/); what it found is in its [`findings/`](../../packages/werk-poc/findings/README.md)                                                              |
| [01-cross-platform.md](01-cross-platform.md)                 | How the stack the proof of concept tested gets to run on macOS, Windows and Linux from one binary: a small platform seam around the daemon, one Linux build job for every target, and a native hosted runner per target to prove it. Measured on the PoC in [`platforms.md`](../../packages/werk-poc/findings/platforms.md); §11 is the hand-off — the traps, the method, and what is left |
| [02-session-library.md](02-session-library.md)               | Three private workspace packages for terminal state, the portable session client/contracts and the Bun daemon, plus a fourth that keeps the renderer seam honest, with their API direction and implementation sequence.                                                                                                                                                                    |
