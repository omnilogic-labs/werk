# werk completion for fish.
#
# Candidates come from `werk complete`, which speaks cobra's `__complete`
# protocol. Its `value<TAB>description` lines are already fish's own completion
# format, so they are printed through unchanged; only the trailing `:<directive>`
# line is acted on and removed.

function __werk_complete
    set -l tokens (commandline -opc)
    set -l current (commandline -ct)
    # A command substitution yields no element for an empty token, and an empty
    # word under the cursor is how `werk attach <TAB>` is told from
    # `werk attach<TAB>`, so it is put back.
    if not set -q current[1]
        set current ""
    end

    set -l out ($tokens[1] complete -- $tokens[2..-1] $current 2>/dev/null)
    or return

    set -l directive 0
    for line in $out
        if string match -qr '^:' -- $line
            set directive (string sub -s 2 -- $line)
        else if test -n "$line"
            printf '%s\n' $line
        end
    end

    # 16 is FilterDirs: werk wants a directory and the shell knows them better.
    if test (math "bitand $directive, 16") -ne 0
        __fish_complete_directories $current
    end
end

# `-f` because werk's answer is authoritative: a command with no candidates has
# none, and offering the current directory instead would be noise.
complete -c werk -f -a '(__werk_complete)'
