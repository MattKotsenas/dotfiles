@{
    RootModule           = 'GitHubCli.psm1'
    ModuleVersion        = '0.1.0'
    GUID                 = 'b2502d22-a42f-47e9-a157-c5d64a18d4db'
    Author               = 'Matt Kotsenas'
    Description          = 'DSC resource to install GitHub CLI extensions.'
    PowerShellVersion    = '7.2'
    DscResourcesToExport = @('GitHubExtension')
}
