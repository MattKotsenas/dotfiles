@{
    RootModule           = 'CargoGit.psm1'
    ModuleVersion        = '0.1.0'
    GUID                 = '173c01d7-6bac-4248-a026-17bc0e669a41'
    Author               = 'Matt Kotsenas'
    Description          = 'DSC resource to install cargo crates from a pinned git revision.'
    PowerShellVersion    = '7.2'
    DscResourcesToExport = @('CargoGitInstall')
}
