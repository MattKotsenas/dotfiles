<#
.SYNOPSIS
Resume a previous Copilot CLI session, with a picker scoped by working directory.

.DESCRIPTION
Scans ~/.copilot/session-state/*/workspace.yaml for past sessions, sorts them by
most-recently-updated, and either resumes one directly (-Last) or opens an
interactive picker. Default filtering is to sessions whose cwd matches or is
under $PWD; use -All to drop that filter.

When fzf is available it provides the picker (with a preview pane showing the
seed prompt). Without fzf, a simple numbered prompt is used.

The chosen session is resumed via `copilot --resume=<id>` so all of Copilot's
normal flags (--allow-all, --model, ...) can be passed via -Rest.

.PARAMETER Last
Resume the most-recently-updated session for the current working directory
(or any directory, with -All) without showing a picker.

.PARAMETER All
Don't restrict the picker to sessions under $PWD; show every saved session.

.PARAMETER Limit
Maximum number of sessions to consider. Default 50.

.PARAMETER Rest
Additional arguments passed through to `copilot --resume=<id> ...`.
E.g. -Rest --allow-all, or -Rest --model gpt-5.4

.EXAMPLE
Resume-CopilotSession
# Open a picker scoped to the current directory.

.EXAMPLE
Resume-CopilotSession -Last
# Resume the most recent session for this directory.

.EXAMPLE
Resume-CopilotSession -All
# Pick from every saved session, not just this directory.

.EXAMPLE
Resume-CopilotSession -- --allow-all --model gpt-5.4
# Pass extra args to copilot after the session is selected.
#>
function Resume-CopilotSession {
    [CmdletBinding()]
    param(
        [switch] $Last,
        [switch] $All,
        [int]    $Limit = 50,
        [Parameter(ValueFromRemainingArguments)]
        [string[]] $Rest
    )

    $stateDir = Join-Path $env:USERPROFILE '.copilot\session-state'
    if (-not (Test-Path $stateDir)) {
        Write-Error "No session state directory at $stateDir"
        return
    }

    # --- Parse workspace.yaml for every session ---
    # The YAML is small and shape-stable; regex is sufficient and avoids a YAML
    # module dependency. Anything that fails to parse is silently skipped.
    $sessions = foreach ($dir in Get-ChildItem $stateDir -Directory -EA SilentlyContinue) {
        $yml = Join-Path $dir.FullName 'workspace.yaml'
        if (-not (Test-Path $yml)) { continue }
        $raw = Get-Content $yml -Raw -EA SilentlyContinue
        if (-not $raw) { continue }

        $id        = if ($raw -match '(?m)^id:\s*(.+?)\s*$')         { $Matches[1] } else { $dir.Name }
        $cwd       = if ($raw -match '(?m)^cwd:\s*(.+?)\s*$')        { $Matches[1] } else { '' }
        $updatedAt = if ($raw -match '(?m)^updated_at:\s*(.+?)\s*$') { $Matches[1] } else { '' }
        $createdAt = if ($raw -match '(?m)^created_at:\s*(.+?)\s*$') { $Matches[1] } else { '' }

        # `name:` is usually a block scalar (`|-` followed by indented lines).
        # Capture the first non-empty line of the block as a one-liner summary.
        $name = ''
        if ($raw -match '(?ms)^name:\s*\|-?\s*\r?\n((?:^[ \t]+.*\r?\n?)+)') {
            $block = $Matches[1]
            $name  = (($block -split "`n") | ForEach-Object { $_.TrimStart() } |
                      Where-Object { $_.Trim() } | Select-Object -First 1)
        }
        elseif ($raw -match '(?m)^name:\s*(.+?)\s*$') {
            $name = $Matches[1]
        }

        # Skip sessions currently held open by another copilot process.
        $inUse = $false
        $lock  = Get-ChildItem $dir.FullName -Filter 'inuse.*.lock' -EA SilentlyContinue | Select-Object -First 1
        if ($lock -and $lock.Name -match '^inuse\.(\d+)\.lock$') {
            $lockPid = [int]$Matches[1]
            if (Get-Process -Id $lockPid -EA SilentlyContinue) { $inUse = $true }
        }

        $updated = $dir.LastWriteTime
        if ($updatedAt) { try { $updated = [DateTime]::Parse($updatedAt) } catch {} }
        $created = $dir.CreationTime
        if ($createdAt) { try { $created = [DateTime]::Parse($createdAt) } catch {} }

        [pscustomobject]@{
            Id        = $id
            ShortId   = $id.Substring(0, [Math]::Min(8, $id.Length))
            Cwd       = $cwd
            Name      = $name
            UpdatedAt = $updated
            CreatedAt = $created
            InUse     = $inUse
        }
    }

    if (-not $sessions) {
        Write-Warning "No saved sessions found."
        return
    }

    # --- Filter by cwd unless -All ---
    # Keep sessions whose cwd matches $PWD or is UNDER $PWD. Windows is
    # case-insensitive, so compare via ToLowerInvariant.
    if (-not $All) {
        $here = (Resolve-Path $PWD).Path.TrimEnd('\','/')
        $hereLower = $here.ToLowerInvariant()
        $prefix    = $hereLower + [IO.Path]::DirectorySeparatorChar
        $matching = $sessions | Where-Object {
            $sCwd = $_.Cwd.TrimEnd('\','/').ToLowerInvariant()
            $sCwd -and ($sCwd -eq $hereLower -or $sCwd.StartsWith($prefix))
        }
        if ($matching) { $sessions = $matching }
        else {
            Write-Host "No sessions match $here; showing all (use -All to suppress this fallback)." -ForegroundColor DarkGray
        }
    }

    $sessions = $sessions | Sort-Object UpdatedAt -Descending | Select-Object -First $Limit

    # --- -Last shortcut: skip the picker ---
    if ($Last) {
        $pick = $sessions | Select-Object -First 1
        if (-not $pick) { Write-Warning "No session to resume."; return }
        Write-Host "Resuming $($pick.ShortId)  $($pick.Cwd)" -ForegroundColor DarkGray
        Write-Host "  $($pick.Name)" -ForegroundColor DarkGray
        & copilot --resume=$($pick.Id) @Rest
        return
    }

    # --- Display rows: id  ago  cwd  name (one truncated line) ---
    $now = Get-Date
    $rows = $sessions | ForEach-Object {
        $age = $now - $_.UpdatedAt
        $ago = if     ($age.TotalMinutes -lt 60)   { '{0,3}m' -f [int]$age.TotalMinutes }
               elseif ($age.TotalHours   -lt 24)   { '{0,3}h' -f [int]$age.TotalHours }
               elseif ($age.TotalDays    -lt 30)   { '{0,3}d' -f [int]$age.TotalDays }
               else                                { '{0,3}mo' -f [int]($age.TotalDays / 30) }
        $cwd = if ($_.Cwd.Length -gt 40) { '...' + $_.Cwd.Substring($_.Cwd.Length - 37) } else { $_.Cwd }
        $tag = if ($_.InUse) { ' [IN USE]' } else { '' }
        # The leading id is what we parse back out of the picker selection.
        '{0}  {1,5}  {2,-40}  {3}{4}' -f $_.ShortId, $ago, $cwd, $_.Name.Trim(), $tag
    }

    # --- Pick: fzf if present, numbered prompt otherwise ---
    $picked = $null
    if (Get-Command fzf -EA SilentlyContinue) {
        $picked = $rows | fzf --no-sort --height=40% --reverse --prompt='copilot resume> ' `
                              --header='Pick a session (esc to cancel)'
    }
    else {
        for ($i = 0; $i -lt $rows.Count; $i++) {
            '{0,3}) {1}' -f ($i + 1), $rows[$i]
        }
        $input = Read-Host "Pick (1-$($rows.Count), enter to cancel)"
        if ($input -match '^\d+$') {
            $idx = [int]$input - 1
            if ($idx -ge 0 -and $idx -lt $rows.Count) { $picked = $rows[$idx] }
        }
    }

    if (-not $picked) { Write-Host "Cancelled." -ForegroundColor DarkGray; return }

    $shortId = ($picked -split '\s+', 2)[0]
    $full = $sessions | Where-Object { $_.ShortId -eq $shortId } | Select-Object -First 1
    if (-not $full) { Write-Error "Could not map selection back to a session id."; return }

    Write-Host "Resuming $($full.ShortId)  $($full.Cwd)" -ForegroundColor DarkGray
    & copilot --resume=$($full.Id) @Rest
}
