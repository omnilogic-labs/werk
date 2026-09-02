#!/bin/sh
# Records the corpus's real sessions (bench/corpus/README.md lists them).
# Needs vim, ls, top, htop, tmux and network for bun install. Re-run to
# refresh; the output differs each time (pids, dates, timings), which is
# fine: the runner compares engines against each other, not against a
# recording.
set -e
cd "$(dirname "$0")/.."
S="${TMPDIR:-/tmp}/wp-corpus-rec"
mkdir -p "$S"
cp src/engine/types.ts "$S/sample.ts"
cat > "$S/package.json" <<'EOF'
{ "name": "wp-corpus-install", "private": true, "dependencies": { "left-pad": "1.3.0", "is-odd": "3.0.1", "chalk": "5.3.0" } }
EOF
R="bun run bench/record.ts"

$R vim --cols 80 --rows 24 --wait 800 \
  --input '[[700,"jjjjj"],[300,"osomething new here\u001b"],[300,":set nu\r"],[300,"/Cell\r"],[300,"ggdd"],[300,"u"],[300,":q!\r"]]' \
  -- vim -u DEFAULTS -N "$S/sample.ts"

$R vim-reattach --cols 80 --rows 24 --wait 600 \
  --input '[[700,"jjj"],[300,"Aedited\u001b"],[300,":set nu\r"]]' \
  -- vim -u DEFAULTS -N "$S/sample.ts"
# The resize the runner applies after each reattach strategy.
printf '[99,"r","100x30"]\n' >> bench/corpus/vim-reattach.cast

$R ls-color --cols 100 --rows 30 --wait 600 -- ls --color=always -la /usr/lib /usr/bin

$R top --cols 100 --rows 30 --wait 600 -- top -b -n 3 -d 1

$R htop --cols 100 --rows 30 --wait 300 --input '[[2500,"q"]]' -- htop -d 10

rm -rf "$S/node_modules" "$S/bun.lock"
$R bun-install --cols 80 --rows 24 --wait 2000 -- sh -c "cd '$S' && bun install --no-cache 2>&1"

tmux -L wpcorpus kill-server 2>/dev/null || true
$R tmux --cols 100 --rows 30 --wait 800 \
  --input '[[900,"echo hello from tmux\r"],[500,"\u0002%"],[900,"ls --color /\r"],[600,"\u0002d"]]' \
  -- tmux -L wpcorpus -f /dev/null new-session
tmux -L wpcorpus kill-server 2>/dev/null || true
