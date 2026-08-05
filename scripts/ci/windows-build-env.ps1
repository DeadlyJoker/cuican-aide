# Puts the build toolchain on PATH for a Windows Flow runner.
#
# The macOS counterpart exists because launchd gives the Runner almost no
# environment. Windows has the same shape of problem for a different reason: the
# Runner runs as a service, so it sees the machine PATH but not the per-user one,
# and rustup and pnpm install per-user by default.
#
# Kept in the repo rather than configured on the machine so it is reviewable and
# a replacement machine gets the same environment.
#
# Dot-source it:  . scripts/ci/windows-build-env.ps1

$ErrorActionPreference = "Stop"

# rustup shims.
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

# pnpm's global bin, where corepack puts its shims.
if ($env:PNPM_HOME -and (Test-Path $env:PNPM_HOME)) {
    $env:PATH = "$env:PNPM_HOME;$env:PATH"
}

# ossutil, installed as a plain binary like it is on macOS.
$localBin = Join-Path $env:USERPROFILE ".local\bin"
if (Test-Path $localBin) {
    $env:PATH = "$localBin;$env:PATH"
}

# Report a missing tool here, where the message can name the reason, rather than
# several commands later where it only names the tool.
foreach ($required in @("cargo", "node", "pnpm")) {
    if (-not (Get-Command $required -ErrorAction SilentlyContinue)) {
        Write-Error "missing $required after setting up PATH; is it installed for this user?`nPATH=$env:PATH"
    }
}
