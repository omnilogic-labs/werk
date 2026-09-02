# Building `win32-x64/ghostty-vt.dll`

`libghostty-vt@0.6.3` ships prebuilds for `darwin-arm64` and
`linux-{x64,arm64}-{glibc,musl}` and nothing else, so the win32 artefact is
built here. Everything below runs on Linux — the DLL is a cross-compile, and
no Windows machine is involved in producing it.

The one thing that must not drift is the ghostty commit. The binding's struct
offsets in its `src/internal/generated.ts` were probed from
`e88c6c099152dd6d2d7e517516e1f3c183c152f7`; build from anything else and the
ABI can disagree without saying so.

## Toolchain

| Item          | Value                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| Zig           | `0.15.2` (`zig-x86_64-linux-0.15.2` from ziglang.org)                      |
| Ghostty       | `e88c6c099152dd6d2d7e517516e1f3c183c152f7` (`build.zig.zon` wants ≥0.15.2) |
| ts-libghostty | `174a418257a7dd30a28929e9ff9b8a978b074526` — for `native/shim.c`           |
| Target triple | `x86_64-windows-gnu`                                                       |

`ts-libghostty`'s own `mise.toml` also pins zig `0.15.2`, and its
`scripts/build-libghostty.sh` refuses anything outside `0.15.*`.

## 1. Sources

```console
$ git init ghostty && cd ghostty
$ git remote add origin https://github.com/ghostty-org/ghostty.git
$ git fetch --depth 1 origin e88c6c099152dd6d2d7e517516e1f3c183c152f7
$ git checkout FETCH_HEAD
$ cd .. && git clone --depth 1 https://github.com/prime-radiant-inc/ts-libghostty.git
```

`shim.c` is not in the npm tarball; it only exists in the GitHub repo, at
`packages/libghostty-vt/native/shim.c`.

## 2. The static library and the headers

```console
$ cd ghostty
$ zig build install -Demit-lib-vt=true -Doptimize=ReleaseFast -Dtarget=x86_64-windows-gnu
```

About a minute. It produces `zig-out/bin/ghostty-vt.dll` (the library alone,
which is not what gets vendored), `zig-out/lib/ghostty-vt-static.lib`, and
`zig-out/include/ghostty/**`.

## 3. One DLL, not two

Upstream builds two objects on Linux and macOS: the library, and a shim that
wraps the four by-value-struct entry points with pointer-taking `_p`
variants. The shim finds the library through `-Wl,-rpath,'$ORIGIN'` (or
`@loader_path`), and Windows has no equivalent — a dependent DLL resolves
from the _loading process's_ directory and the DLL search path, not from the
directory of the DLL that depends on it.

Linking the shim against `ghostty-vt-static.lib` produces one self-contained
DLL that exports both sets of symbols, which sidesteps the question. The
binding dlopens the library and the shim separately and takes an explicit
path for each, so both can point at the same file.

`ghostty-vt.def` lists the exports: the 129 `ghostty_*` symbols the upstream
Windows DLL exports, plus the shim's four `_p` functions. It is committed
next to the artefact. To regenerate it, read the export table of
`ghostty/zig-out/bin/ghostty-vt.dll` and append the four names.

`-DGHOSTTY_STATIC` makes the headers' `GHOSTTY_API` a no-op; without it the
shim's calls go through `__declspec(dllimport)` thunks into a library that is
in the same image, and lld warns `LNK4217` four times.

```console
$ zig cc -target x86_64-windows-gnu -O2 -shared -DGHOSTTY_STATIC \
    -I ghostty/zig-out/include \
    -o ghostty-vt.dll \
    ts-libghostty/packages/libghostty-vt/native/shim.c \
    ghostty/zig-out/lib/ghostty-vt-static.lib \
    ghostty-vt.def
```

The result imports `KERNEL32.dll`, `ntdll.dll` and five
`api-ms-win-crt-*.dll` forwarders, and nothing else — no mingw runtime, no
second ghostty DLL.

`LICENSE` is copied from the ghostty checkout at the pinned commit (MIT,
Mitchell Hashimoto and contributors). `shim.c` is Apache-2.0 from
ts-libghostty; its licence is in that package's `LICENSE`, which
`node_modules/libghostty-vt` already carries.

The link is not byte-reproducible: the PE header timestamp and the CodeView
build-id change on every run, so two links of identical inputs differ in
about 5 KB out of 1.6 MB. `-Wl,/Brepro` does not help. The `sha256` in `PIN`
therefore identifies the artefact that is committed rather than one anybody
can re-derive.

## 4. Checking the ABI rather than assuming it

Windows x64 differs from SysV amd64 in exactly the by-value struct passing
the shim exists to wrap, so the shim covers the calling convention. Field
layout is a separate question and worth checking.

`ts-libghostty`'s `scripts/probe-layout.c` emits the layout of all twelve
structs the binding reads or writes, but it has to run, and a Windows binary
does not run here. Instead, compile it natively, turn every size, alignment,
field offset and field size it reports into a `_Static_assert`, and compile
_that_ for Windows:

```console
$ zig cc -O2 -I ghostty/zig-out/include -o probe ts-libghostty/.../probe-layout.c
$ ./probe > layout-linux.json          # 12 structs
# generate assert-layout.c: 140 _Static_asserts over those numbers
$ zig cc -target x86_64-windows-gnu -I ghostty/zig-out/include -c assert-layout.c
```

All 140 pass. The layouts are identical, so `generated.ts` is correct on
win32 and no Windows-specific regeneration is needed.

As a second check, feeding `layout-linux.json` back through the binding's own
`scripts/gen-bindings.ts` reproduces the committed `src/internal/generated.ts`
byte for byte, which confirms this checkout of ghostty is the one the shipped
binding was probed from.

## 5. `darwin-x64` does not fall out of this

`zig build -Dtarget=x86_64-macos` fails from a Linux host at this commit:
ghostty's C++ dependencies (`simdutf`, `highway`) get compiled against the
host's `/usr/include` instead of a macOS SDK, and fall over on
`__float128` and `__TC__`. Cross-compiling C++ to macOS needs the SDK, which
is not redistributable. A `darwin-x64` prebuild probably wants a macOS
runner, where `-Dtarget=x86_64-macos` has an SDK to hand — the same place
upstream's `darwin-arm64` prebuild is built.
