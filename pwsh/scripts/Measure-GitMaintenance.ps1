function Get-GitMaintenanceRepo {
    <#
    .SYNOPSIS
        Lists repos registered for git background maintenance.
    .DESCRIPTION
        Reads the maintenance.repo entries from the global git config and returns
        an object per registered repo. These are the repos that `git maintenance start`
        will service on its scheduled runs (hourly, daily, weekly).
    .OUTPUTS
        PSCustomObject with PSTypeName 'GitMaintenanceRepo'.
            Path - The full path to the repo.
            Name - The folder name of the repo.
    .EXAMPLE
        Get-GitMaintenanceRepo

        Lists all repos currently registered for background maintenance.
    .EXAMPLE
        Get-GitMaintenanceRepo | Select-Object -ExpandProperty Path

        Returns just the paths of registered repos.
    .LINK
        https://git-scm.com/docs/git-maintenance
    #>
    [CmdletBinding()]
    param()

    $paths = git config --global --get-all maintenance.repo 2>$null
    if (-not $paths) { return }

    foreach ($p in $paths) {
        $normalized = [System.IO.Path]::GetFullPath($p)
        [PSCustomObject]@{
            PSTypeName = 'GitMaintenanceRepo'
            Path       = $normalized
            Name       = Split-Path $normalized -Leaf
        }
    }
}

function Measure-GitMaintenanceScore {
    <#
    .SYNOPSIS
        Scores git repos on how much they'd benefit from git background maintenance.
    .DESCRIPTION
        Inspects the .git directory of each repo for indicators of accumulated cruft:
        loose ref files, loose objects, pack file count, missing commit-graph, total
        ref count, and overall .git size. Produces a weighted score per repo.

        Scoring thresholds and weights:
          - Loose refs > 500:      weight 3 (capped at 10x)
          - Loose objects > 1000:  weight 2 (capped at 10x)
          - Pack files > 10:       weight 2 (capped at 5x)
          - No commit-graph:       flat 1 point
          - Total refs > 5000:     weight 2 (capped at 10x)
          - .git size > 500 MB:    weight 1 (capped at 5x)

        Reading the score:
          0       Clean. No maintenance needed.
          1       Typically just a missing commit-graph. Harmless.
          2 - 5   Minor cruft. Maintenance is optional but won't hurt.
          5 - 10  Noticeable overhead. Registering for maintenance is recommended.
          10+     Heavy cruft across multiple dimensions. Maintenance strongly recommended.
          20+     Severely degraded. Expect noticeable slowdowns in everyday git operations.

        The scale is not linear and has no fixed maximum. It grows with the severity and
        number of dimensions that exceed their thresholds. Use it for relative ranking
        across your repos rather than as an absolute measure.
    .PARAMETER Path
        Path to a git repository. Accepts pipeline input from Get-ChildItem or strings.
        Defaults to the current directory.
    .OUTPUTS
        PSCustomObject with PSTypeName 'GitMaintenanceScore'.
            Path         - Full path to the repo.
            Name         - Folder name of the repo.
            LooseRefs    - Number of loose ref files (tags + heads + remotes).
            LooseObjects - Number of loose object files in .git/objects.
            Packs        - Number of .pack files.
            CommitGraph  - Whether a commit-graph file exists.
            TotalRefs    - Total refs (packed + loose).
            SizeMB       - Size of .git directory in MB.
            Score        - Weighted maintenance score (0 = clean).
            Registered   - Whether the repo is already registered for maintenance.
    .EXAMPLE
        Measure-GitMaintenanceScore

        Scores the current directory's git repo.
    .EXAMPLE
        Get-ChildItem C:\Projects -Directory | Measure-GitMaintenanceScore | Sort-Object Score -Descending

        Scores all repos under C:\Projects, sorted by most in need of maintenance.
    .EXAMPLE
        Measure-GitMaintenanceScore C:\Projects\myrepo

        Scores a single repo by path.
    .EXAMPLE
        Get-ChildItem C:\Projects -Directory |
            Measure-GitMaintenanceScore |
            Where-Object { $_.Score -gt 5 -and -not $_.Registered } |
            ForEach-Object { git -C $_.Path maintenance register }

        Registers all high-scoring, unregistered repos for background maintenance.
    .LINK
        https://git-scm.com/docs/git-maintenance
    #>
    [CmdletBinding()]
    param(
        [Parameter(ValueFromPipeline, ValueFromPipelineByPropertyName, Position = 0)]
        [Alias('FullName')]
        [string]$Path
    )

    begin {
        $registeredSet = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        $registered = git config --global --get-all maintenance.repo 2>$null
        if ($registered) {
            foreach ($r in $registered) {
                [void]$registeredSet.Add([System.IO.Path]::GetFullPath($r))
            }
        }
    }

    process {
        if (-not $Path) { $Path = Get-Location }
        $resolvedPath = (Resolve-Path $Path -ErrorAction SilentlyContinue).Path
        if (-not $resolvedPath) { return }

        $gitDir = git -C $resolvedPath rev-parse --git-dir 2>$null
        if (-not $gitDir) { return }
        $gitDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($resolvedPath, $gitDir))

        # Loose refs (no git plumbing command exposes loose-vs-packed, so filesystem is the only way)
        $looseRefs = 0
        foreach ($sub in 'refs\tags', 'refs\heads', 'refs\remotes') {
            $d = Join-Path $gitDir $sub
            if (Test-Path $d) {
                $looseRefs += (Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue |
                    Measure-Object).Count
            }
        }

        # Parse `git count-objects -v` for loose objects, pack count, and sizes
        $countObjects = git -C $resolvedPath count-objects -v 2>$null
        $looseObjects = 0
        $packCount = 0
        $sizeKB = 0
        $sizePackKB = 0
        foreach ($line in $countObjects) {
            if ($line -match '^count:\s*(\d+)')     { $looseObjects = [int]$Matches[1] }
            if ($line -match '^packs:\s*(\d+)')     { $packCount = [int]$Matches[1] }
            if ($line -match '^size:\s*(\d+)')       { $sizeKB = [long]$Matches[1] }
            if ($line -match '^size-pack:\s*(\d+)')  { $sizePackKB = [long]$Matches[1] }
        }
        $sizeMB = [math]::Round(($sizeKB + $sizePackKB) / 1024, 1)

        # Commit graph
        $hasCommitGraph = (Test-Path (Join-Path $gitDir "objects\info\commit-graph")) -or
                          (Test-Path (Join-Path $gitDir "objects\info\commit-graphs"))

        # Total refs via git for-each-ref
        $totalRefs = (git -C $resolvedPath for-each-ref --format='x' 2>$null | Measure-Object).Count

        # Weighted score
        $score = 0
        if ($looseRefs -gt 500)     { $score += [math]::Min($looseRefs / 500, 10) * 3 }
        if ($looseObjects -gt 1000) { $score += [math]::Min($looseObjects / 1000, 10) * 2 }
        if ($packCount -gt 10)      { $score += [math]::Min($packCount / 10, 5) * 2 }
        if (-not $hasCommitGraph)   { $score += 1 }
        if ($totalRefs -gt 5000)    { $score += [math]::Min($totalRefs / 5000, 10) * 2 }
        if ($sizeMB -gt 500)        { $score += [math]::Min($sizeMB / 500, 5) }

        [PSCustomObject]@{
            PSTypeName   = 'GitMaintenanceScore'
            Path         = $resolvedPath
            Name         = Split-Path $resolvedPath -Leaf
            LooseRefs    = $looseRefs
            LooseObjects = $looseObjects
            Packs        = $packCount
            CommitGraph  = $hasCommitGraph
            TotalRefs    = $totalRefs
            SizeMB       = $sizeMB
            Score        = [math]::Round($score, 1)
            Registered   = $registeredSet.Contains($resolvedPath)
        }
    }
}
