# Class-based DSC resource: install a cargo crate (or crates) from a pinned git
# revision. Fills the gap RustDsc/CargoToolInstall leaves (it's crates.io-only,
# with no --git). Test compares the installed rev (from `cargo install --list`)
# against the pin, so a converged re-run is a cheap local check with no rebuild.

[DscResource()]
class CargoGitInstall {
    # Git repository URL, e.g. https://github.com/owner/repo.git
    [DscProperty(Key)]
    [string] $Url

    # Exact commit SHA to install.
    [DscProperty(Mandatory)]
    [string] $Rev

    # Crate(s) / binaries to install from the repo.
    [DscProperty(Mandatory)]
    [string[]] $Crates

    # Pass --locked for a reproducible dependency tree.
    [DscProperty()]
    [bool] $Locked = $true

    [DscProperty(NotConfigurable)]
    [string] $InstalledRev

    hidden [void] RefreshPath() {
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')
    }

    hidden [string] CargoList() {
        $this.RefreshPath()
        return (cargo install --list 2>$null) -join "`n"
    }

    # The abbreviated rev `cargo install --list` reports for $crate, or ''.
    hidden [string] RevOf([string] $crate, [string] $list) {
        $m = [regex]::Match($list, "(?m)^$crate\s.*#([0-9a-fA-F]+)\)")
        if ($m.Success) { return $m.Groups[1].Value.ToLower() }
        return ''
    }

    [CargoGitInstall] Get() {
        $this.InstalledRev = $this.RevOf($this.Crates[0], $this.CargoList())
        return $this
    }

    [bool] Test() {
        $list = $this.CargoList()
        # cargo reports the short hash; the pin is the full SHA, so prefix-match.
        # Every crate this resource installs must be present and at the pin.
        foreach ($crate in $this.Crates) {
            $installed = $this.RevOf($crate, $list)
            if (-not ([bool]$installed -and $this.Rev.ToLower().StartsWith($installed))) { return $false }
        }
        return $true
    }

    [void] Set() {
        $this.RefreshPath()
        $cargoArgs = @('install', '--git', $this.Url, '--rev', $this.Rev)
        if ($this.Locked) { $cargoArgs += '--locked' }
        $cargoArgs += $this.Crates
        & cargo @cargoArgs 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "cargo install --git $($this.Url) failed with exit code $LASTEXITCODE" }
    }
}
