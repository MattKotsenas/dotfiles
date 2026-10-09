[DscResource()]
class GitHubExtension {
    [DscProperty(Key)]
    [string] $Repository

    [DscProperty(NotConfigurable)]
    [bool] $Installed

    hidden [void] RefreshPath() {
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')
    }

    [GitHubExtension] Get() {
        $this.RefreshPath()
        $output = @(gh extension list 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "gh extension list failed (exit $LASTEXITCODE): $($output -join "`n")"
        }
        $repositories = @($output | ForEach-Object {
            if ($_ -match '^\S+\s+\S+\s+(\S+)') { $matches[1] }
        })
        $this.Installed = $this.Repository -in $repositories
        return $this
    }

    [bool] Test() {
        return $this.Get().Installed
    }

    [void] Set() {
        $this.RefreshPath()
        gh extension install $this.Repository 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "gh extension install $($this.Repository) failed (exit $LASTEXITCODE)"
        }
    }
}
