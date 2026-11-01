# Krypton — native command output pager hints for fish (spec 353).
#
# Krypton puts this file's directory first in XDG_DATA_DIRS for fish panes, so
# fish sources it from vendor_conf.d the way kitty's shell integration loads.
# While a plain `git diff` runs, GIT_PAGER=cat keeps the diff out of a pager
# (less, delta), so the whole unified diff lands in the terminal, where
# Krypton draws its native card over it (spec 351). Everything is put back
# when the command ends. Lines with pipes, lists or redirections, `git -p`,
# and external diff drivers (difftastic) are left alone.

# Take Krypton's directory back out of XDG_DATA_DIRS, so programs started from
# this shell see the user's own value.
if set -q KRYPTON_FISH_XDG_DATA_DIR
    if set -q KRYPTON_XDG_DATA_DIRS_UNSET
        set --erase --global XDG_DATA_DIRS
    else
        set --local dirs (string split : -- "$XDG_DATA_DIRS")
        set --local keep (string match --invert -- "$KRYPTON_FISH_XDG_DATA_DIR" $dirs)
        set --global --export XDG_DATA_DIRS (string join : -- $keep)
    end
    set --erase KRYPTON_FISH_XDG_DATA_DIR KRYPTON_XDG_DATA_DIRS_UNSET
end

status is-interactive; or exit 0
set -q KRYPTON_NATIVE_OUTPUT; or exit 0
set --erase KRYPTON_NATIVE_OUTPUT

# The variables that keep command line `$argv[1]` out of a pager, as
# name/value pairs. Only `git diff` gets one: it is the output Krypton reads.
function __krypton_native_hints --description "Pager hints for a command line"
    string match -qr '[|;&<>]' -- $argv[1]; and return
    set --local w (string split --no-empty ' ' -- $argv[1])
    while set -q w[1]
        switch $w[1]
            case sudo env time command nice nohup
                set -e w[1]
                while string match -q -- '-*' $w[1]
                    set -e w[1]
                end
            case '*=*'
                string match -qr '^[A-Za-z_][A-Za-z0-9_]*=' -- $w[1]; or break
                set -e w[1]
            case '*'
                break
        end
    end
    set -q w[1]; or return
    test (string replace -r '.*/' '' -- $w[1]) = git; or return
    set -e w[1]
    while string match -q -- '-*' $w[1]
        # `git -p diff` asks for the pager: leave it be.
        contains -- $w[1] -p --paginate; and return
        contains -- $w[1] -C -c; and set -e w[1]
        set -e w[1]
    end
    test "$w[1]" = diff; or return
    # An external diff tool prints what Krypton cannot read: git's pager stays.
    if not contains -- --no-ext-diff $w
        set -q GIT_EXTERNAL_DIFF; and test -n "$GIT_EXTERNAL_DIFF"; and return
        set --local external (command git config --get diff.external 2>/dev/null)
        test -n "$external"; and return
    end
    echo GIT_PAGER cat
end

# Each hinted variable, followed by what it was: `x` exported, `s` set but not
# exported, `u` unset, then the old value.
set --global __krypton_hinted

function __krypton_native_hint --on-event fish_preexec --description "Exports the pager hints for a command line"
    for hint in (__krypton_native_hints "$argv[1]")
        set --local pair (string split --max 1 ' ' -- $hint)
        set --local name $pair[1]
        if set -qx $name
            set --append __krypton_hinted $name x "$$name"
        else if set -q $name
            set --append __krypton_hinted $name s "$$name"
        else
            set --append __krypton_hinted $name u ''
        end
        set --global --export $name "$pair[2]"
    end
end

function __krypton_native_unhint --on-event fish_postexec --description "Puts back what the pager hints replaced"
    while set -q __krypton_hinted[3]
        set --local name $__krypton_hinted[1]
        set --erase --global $name
        switch $__krypton_hinted[2]
            case x
                set --global --export $name $__krypton_hinted[3]
            case s
                set --global $name $__krypton_hinted[3]
        end
        set --erase __krypton_hinted[1..3]
    end
end
