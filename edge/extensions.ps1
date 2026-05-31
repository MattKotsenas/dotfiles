# Verifies that expected Microsoft Edge extensions are installed in the user's
# active profile, and prints loud install instructions for anything missing.
#
# We *cannot* force-install via group policy on this account — HKCU\Software\
# Policies is locked by corp IT (Azure AD-joined machine, REDMOND domain) and
# HKLM writes require admin. Extensions are installed manually via the Edge UI;
# this script is the guardrail that catches drift across machines.
#
# Matches extensions by manifest name so no filesystem path is baked in. Works
# for both store-installed (location 1) and unpacked (location 4) extensions.
#
# Idempotent. Exits nonzero with a banner if anything is missing.

[CmdletBinding()]
param(
    [string] $ProfileName = 'Profile 1'
)

$ErrorActionPreference = 'Stop'

# ----- Expected extensions ---------------------------------------------------

# Each entry: a manifest name to look up, and instructions to print if missing.
# Source is informational only — we don't try to install automatically.
$Expected = @(
    @{
        ManifestName = 'Vimium'
        InstallUrl   = 'https://chromewebstore.google.com/detail/vimium/dbepggeogbaibhgnhhndojpepiihcmeb'
    }
    @{
        ManifestName = 'Refined GitHub'
        InstallUrl   = 'https://chromewebstore.google.com/detail/refined-github/hlepfoohegkhhmjieoechaddaejaokhf'
    }
    @{
        ManifestName = 'Catppuccin for Web File Explorer Icons'
        InstallUrl   = 'https://microsoftedge.microsoft.com/addons/detail/enicfllfdibbjhnpembomakaamcdcakl'
        Instructions = @(
            'Or, to use the in-development fork (PR diff/commit tree icons):'
            '    git clone --recurse-submodules https://github.com/MattKotsenas/web-file-explorer-icons.git'
            '    cd web-file-explorer-icons'
            '    pnpm install && pnpm build'
            'Then in Edge:'
            '    1. Open edge://extensions/'
            '    2. Toggle "Developer mode" on (top-right)'
            '    3. Click "Load unpacked" and select <repo>/dist/chrome-mv3/'
        )
    }
)

# ----- Read Edge profile preferences -----------------------------------------

$profileDir = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data\$ProfileName"
if (-not (Test-Path $profileDir)) {
    Write-Warning "Edge profile '$ProfileName' has no directory yet at: $profileDir"
    Write-Warning "Launch Edge once with this profile, then re-run dotbot."
    exit 1
}

# Edge splits extension state across two files: most data lives in
# `Secure Preferences` (tamper-protected store), some in `Preferences`. Read
# both and merge — first-seen-wins by extension id.
$prefsFiles = @('Preferences', 'Secure Preferences')
$mergedSettings = @{}
foreach ($file in $prefsFiles) {
    $path = Join-Path $profileDir $file
    if (-not (Test-Path $path)) { continue }
    try {
        $json = Get-Content -Path $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Warning "Could not parse '$path' (Edge may be writing to it): $($_.Exception.Message)"
        continue
    }
    $settings = $json.extensions.settings
    if (-not $settings) { continue }
    foreach ($id in $settings.PSObject.Properties.Name) {
        if (-not $mergedSettings.ContainsKey($id)) {
            $mergedSettings[$id] = $settings.$id
        }
    }
}

if ($mergedSettings.Count -eq 0) {
    Write-Warning "No extension settings found in either Preferences file under $profileDir."
    Write-Warning "Launch Edge once with this profile, then re-run dotbot."
    exit 1
}

# ----- Index installed extensions by manifest name ---------------------------

# Chromium ExtensionPrefs::Location enum values we care about:
#   1 = INTERNAL       (Edge Add-ons / Chrome Web Store)
#   4 = LOAD_UNPACKED  (developer-mode load)
# Anything else (external pref, registry, component, etc.) is ignored — we
# don't expect to manage extensions installed by other means.
$relevantLocations = @(1, 4)
$installed = @{}

foreach ($id in $mergedSettings.Keys) {
    $ext = $mergedSettings[$id]
    if ($ext.location -notin $relevantLocations) { continue }

    $name = $ext.manifest.name
    # Store paths in Secure Preferences are relative to the profile's
    # Extensions/ subfolder; unpacked paths are absolute. Resolve relative
    # paths so the message we print is actionable.
    $extPath = $ext.path
    if ($extPath -and -not [System.IO.Path]::IsPathRooted($extPath)) {
        $extPath = Join-Path (Join-Path $profileDir 'Extensions') $extPath
    }

    # Manifest name may be a localization key like __MSG_extName__; resolve it
    # via _locales/<default_locale>/messages.json under the extension's
    # resolved path before comparing.
    if ($name -match '^__MSG_(.+)__$' -and $extPath) {
        $key = $matches[1]
        $defaultLocale = $ext.manifest.default_locale
        if ($defaultLocale) {
            $messagesPath = Join-Path $extPath "_locales\$defaultLocale\messages.json"
            if (Test-Path $messagesPath) {
                try {
                    $messages = Get-Content $messagesPath -Raw | ConvertFrom-Json
                    $resolved = $messages.$key.message
                    if ($resolved) { $name = $resolved }
                } catch { } # fall through with the unresolved __MSG_*__
            }
        }
    }

    if (-not $name) { continue }
    # Skip stale entries whose path no longer exists on disk (e.g., unpacked
    # extensions whose source dir was deleted/renamed). Edge keeps the prefs
    # entry around but the extension isn't actually loadable.
    if ($extPath -and -not (Test-Path $extPath)) { continue }

    # Same name can appear twice (store + unpacked); first-seen wins.
    if (-not $installed.ContainsKey($name)) {
        $installed[$name] = [pscustomobject]@{
            Id       = $id
            Location = $ext.location
            Path     = $extPath
        }
    }
}

# ----- Compare against expected ----------------------------------------------

$missing = @()
foreach ($expected in $Expected) {
    $name = $expected.ManifestName
    $found = $installed[$name]
    if ($found) {
        $locationLabel = switch ($found.Location) {
            1 { 'store' }
            4 { 'unpacked' }
            default { "location=$($found.Location)" }
        }
        $detail = if ($found.Path) { " <- $($found.Path)" } else { '' }
        Write-Host "  - [$locationLabel] $name$detail" -ForegroundColor DarkGray
    } else {
        $missing += $expected
    }
}

if ($missing.Count -eq 0) { exit 0 }

# ----- Loud-failure banner ---------------------------------------------------

$line = '!' * 70
Write-Host ''
Write-Host $line -ForegroundColor Red
Write-Host '!!! MANUAL ACTION REQUIRED: missing Edge extensions !!!' -ForegroundColor Red
Write-Host "    (profile '$ProfileName')" -ForegroundColor Red
Write-Host $line -ForegroundColor Red

foreach ($expected in $missing) {
    Write-Host ''
    Write-Host "Missing: $($expected.ManifestName)" -ForegroundColor Red
    if ($expected.InstallUrl) {
        Write-Host "  Install: $($expected.InstallUrl)" -ForegroundColor Yellow
    }
    if ($expected.Instructions) {
        foreach ($step in $expected.Instructions) {
            Write-Host "  $step" -ForegroundColor Yellow
        }
    }
}

Write-Host ''
Write-Host $line -ForegroundColor Red
exit 1
