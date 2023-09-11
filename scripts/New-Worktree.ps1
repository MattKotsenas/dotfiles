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
        $BaseBranch = "$(git remote)/$(git symbolic-ref HEAD --short)"
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"

    git branch --no-track $BranchName $BaseBranch
    git worktree add $DirectoryName $BranchName

    cd $DirectoryName
}
