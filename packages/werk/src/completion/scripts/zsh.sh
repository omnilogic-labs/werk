#compdef werk

# werk completion for zsh.
#
# Candidates come from `werk complete`, which speaks cobra's `__complete`
# protocol: one `value<TAB>description` line per candidate, then a `:<directive>`
# line of flags for this script to act on.

__werk_complete() {
    local -a args lines values
    local out line value description directive

    # Quoted so empty words survive: an empty word under the cursor is how
    # `werk attach <TAB>` is told from `werk attach<TAB>`.
    args=("${(@)words[2,CURRENT-1]}")
    args+=("${words[CURRENT]-}")

    out=$("${words[1]}" complete -- "${args[@]}" 2>/dev/null) || return 1
    lines=("${(@f)out}")

    directive=0
    for line in "${lines[@]}"; do
        [[ -z $line ]] && continue
        if [[ $line == :* ]]; then
            directive=${line#:}
            continue
        fi
        value=${line%%$'\t'*}
        description=${line#*$'\t'}
        # `_describe` reads a colon as the start of the description.
        value=${value//:/\\:}
        if [[ $description == $line ]]; then
            values+=("$value")
        else
            values+=("$value:$description")
        fi
    done

    # 1 is Error: werk could not answer, so say nothing.
    (( (directive & 1) != 0 )) && return 1
    # 16 is FilterDirs: werk wants a directory and the shell knows them better.
    if (( (directive & 16) != 0 )); then
        _path_files -/
        return
    fi

    local -a describe_options
    # 2 is NoSpace: the candidate is half a word, such as a `KEY=` label.
    (( (directive & 2) != 0 )) && describe_options+=(-S '')
    # 32 is KeepOrder: werk sorted these on purpose.
    (( (directive & 32) != 0 )) && describe_options+=(-V werk)

    if (( ${#values} > 0 )); then
        _describe -t werk werk values "${describe_options[@]}"
        return
    fi
    # 4 is NoFileComp: no candidates means no candidates, not a file listing.
    (( (directive & 4) != 0 )) && return 1
    _files
}

compdef __werk_complete werk
