function New-Worktree
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]
        $DirectoryName,

        [Parameter(Mandatory = $false)]
        [string]
        $BranchName = "users/mattkot/$DirectoryName",

        [Parameter(Mandatory = $false)]
        [string]
        $BaseBranch = "origin/main"
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"

    git branch --no-track $BranchName $BaseBranch
    git worktree add $DirectoryName $BranchName
}
