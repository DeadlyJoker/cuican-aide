#!/bin/sh
# Puts the build toolchain on PATH for a macOS Flow runner.
#
# The Runner is started by launchd, which gives it `/usr/bin:/bin:/usr/sbin:/sbin`
# and nothing else -- no `.zshrc`, no Homebrew, no rustup shims. Every tool this
# build needs lives outside that PATH, so the first command in a job would fail
# with `command not found`.
#
# This lives in the repo rather than in the machine's launchd configuration for
# two reasons: it is reviewable, and a second build machine gets the same
# environment without anyone remembering what was set by hand.
#
# Source it, do not execute it:  . scripts/ci/macos-build-env.sh

# Homebrew, and whatever it has linked into its bin.
if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Node is a versioned Homebrew formula, so it is not on the default Homebrew
# PATH. Pinned to the major version the repo requires rather than `node` so a
# newer keg installed later cannot silently change the build.
for node_prefix in /opt/homebrew/opt/node@24 /opt/homebrew/opt/node@22; do
    if [ -d "$node_prefix/bin" ]; then
        PATH="$node_prefix/bin:$PATH"
        break
    fi
done

# rustup shims.
if [ -d "$HOME/.cargo/bin" ]; then
    PATH="$HOME/.cargo/bin:$PATH"
fi

# ossutil, installed per-user because it ships as a plain binary.
if [ -d "$HOME/.local/bin" ]; then
    PATH="$HOME/.local/bin:$PATH"
fi

export PATH

# Report a missing tool here, where the message can name the reason, rather than
# three commands later where it only names the tool.
#
# A sourced script cannot reliably abort its caller: `return` only sets a status,
# and under `set -e` that status is not checked for a `.` command. So the caller
# is expected to run this under `set -e` *and* the workflow calls it as
# `. script || exit 1`. Both are cheap; silently continuing is not.
crewon_missing_tool=""
for crewon_required in cargo node pnpm; do
    if ! command -v "$crewon_required" >/dev/null 2>&1; then
        crewon_missing_tool="$crewon_required"
        break
    fi
done
unset crewon_required

if [ -n "$crewon_missing_tool" ]; then
    echo "missing $crewon_missing_tool after setting up PATH; is it installed for this user?" >&2
    echo "PATH=$PATH" >&2
    unset crewon_missing_tool
    return 1 2>/dev/null || exit 1
fi
unset crewon_missing_tool
