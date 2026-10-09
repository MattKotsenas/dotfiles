using module ./0.1.0/GitHubCli.psd1

BeforeAll {
    $originalPath = $env:Path
    # Replace only the CLI boundary; never install or modify real extensions.
    function global:gh {
        $global:ghCalls += ,@($args)
        $global:LASTEXITCODE = $global:ghExitCode
        switch ($args[1]) {
            'list' { $global:ghOutput }
            'install' {
                if ($global:ghExitCode -eq 0) {
                    $global:ghOutput += "gh stack`t$($args[2])`tv0.2.1"
                }
            }
            default { throw "Unexpected gh command: $args" }
        }
    }
}

AfterAll {
    Remove-Item Function:\gh
    Remove-Variable ghCalls, ghExitCode, ghOutput -Scope Global
    $env:Path = $originalPath
}

Describe 'GitHubExtension' {
    BeforeEach {
        $global:ghCalls = @()
        $global:ghExitCode = 0
        $global:ghOutput = @()
        $resource = [GitHubExtension]::new()
        $resource.Repository = 'github/gh-stack'
    }

    It 'reports presence for <Name>' -ForEach @(
        @{ Name = 'empty list'; Output = @(); Repository = 'github/gh-stack'; Installed = $false }
        @{ Name = 'unrelated extension'; Output = @("gh act`tnektos/gh-act`tv0.2.89"); Repository = 'github/gh-stack'; Installed = $false }
        @{ Name = 'same name, different owner'; Output = @("gh stack`tother/gh-stack`tv0.2.1"); Repository = 'github/gh-stack'; Installed = $false }
        @{ Name = 'stack among other extensions'; Output = @("gh act`tnektos/gh-act`tv0.2.89", "gh stack`tgithub/gh-stack`tv0.2.1"); Repository = 'github/gh-stack'; Installed = $true }
        @{ Name = 'notifications'; Output = @('gh notifications  xirzec/gh-notifications  v0.5.0'); Repository = 'xirzec/gh-notifications'; Installed = $true }
        @{ Name = 'different installed version'; Output = @("gh stack`tgithub/gh-stack`tv0.1.0"); Repository = 'github/gh-stack'; Installed = $true }
    ) {
        $global:ghOutput = $Output
        $resource.Repository = $Repository
        $resource.Get().Installed | Should -Be $Installed
        $resource.Test() | Should -Be $Installed
        $global:ghCalls.Count | Should -Be 2
        foreach ($call in $global:ghCalls) {
            ($call -join ' ') | Should -Be 'extension list'
        }
    }

    It 'does not treat a failed list as a missing extension' {
        $global:ghExitCode = 1
        $global:ghOutput = @('authentication failed')
        { $resource.Test() } | Should -Throw '*gh extension list failed (exit 1)*authentication failed*'
        $global:ghCalls.Count | Should -Be 1
    }

    It 'installs the configured repository and then reports convergence' {
        $resource.Test() | Should -BeFalse
        $resource.Set()
        ($global:ghCalls[1] -join ' ') | Should -Be 'extension install github/gh-stack'
        $resource.Test() | Should -BeTrue
    }

    It 'surfaces installation failures' {
        $global:ghExitCode = 2
        { $resource.Set() } | Should -Throw '*gh extension install github/gh-stack failed (exit 2)*'
        $global:ghOutput.Count | Should -Be 0
    }
}
