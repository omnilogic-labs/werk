# werk completion for bash.
#
# Candidates come from `werk complete`, which speaks cobra's `__complete`
# protocol: one `value<TAB>description` line per candidate, then a `:<directive>`
# line of flags for this script to act on.
#
# The words are passed to werk as arguments rather than interpolated into an
# `eval`. They are whatever the user typed on the command line, so a name
# containing `$(...)` or a backtick must not be able to run.

__werk_complete() {
    local i out line directive cur
    local -a args candidates

    for ((i = 1; i < COMP_CWORD; i++)); do args+=("${COMP_WORDS[i]}"); done
    # The word under the cursor is always sent, empty included: an empty last
    # word is how `werk attach <TAB>` is told from `werk attach<TAB>`.
    cur="${COMP_WORDS[COMP_CWORD]-}"
    args+=("$cur")

    out=$("${COMP_WORDS[0]}" complete -- "${args[@]}" 2>/dev/null) || return

    directive=0
    while IFS= read -r line; do
        case "$line" in
            "") ;;
            :*) directive="${line#:}" ;;
            *) candidates+=("${line%%$'\t'*}") ;;
        esac
    done <<< "$out"

    # 1 is Error: werk could not answer, so leave the shell's own behaviour alone.
    if (((directive & 1) != 0)); then return 1; fi
    # 4 is NoFileComp: no candidates means no candidates, not a file listing.
    if (((directive & 4) != 0)); then compopt +o default; fi
    # 2 is NoSpace: the candidate is half a word, such as a `KEY=` label.
    if (((directive & 2) != 0)); then compopt -o nospace; fi
    # 16 is FilterDirs: werk wants a directory and the shell knows them better.
    if (((directive & 16) != 0)); then
        compopt -o dirnames
        return 0
    fi

    COMPREPLY=()
    if ((${#candidates[@]} > 0)); then COMPREPLY=("${candidates[@]}"); fi
}

complete -o default -F __werk_complete werk
