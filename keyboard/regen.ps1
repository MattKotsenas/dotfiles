# Regenerates all keymap-derived artifacts from the DSL.
#
# Run after editing keyboard/keymap-gen/ProductionKeymap.cs or the compiler itself.
#
# Generates:
#   kanata/kanata.kbd  -- the kanata config used at runtime
#   (future) komorebi/event-listeners/Generated/LayerCatalog.g.cs
#   (future) keyboard/KEYMAP.md

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$compiler = "$repoRoot\keyboard\keymap-gen"

Write-Host "Building keymap-gen..." -ForegroundColor Cyan
& dotnet build $compiler --nologo --verbosity quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw "keymap-gen build failed" }

Write-Host "Emitting artifacts..." -ForegroundColor Cyan
& dotnet run --project $compiler --no-build --verbosity quiet -- emit-all $repoRoot
if ($LASTEXITCODE -ne 0) { throw "keymap-gen emit failed" }

$kbdPath = "$repoRoot\kanata\kanata.kbd"

Write-Host "Validating with kanata..." -ForegroundColor Cyan
$kanataBin = "$repoRoot\kanata\kanata_winIOv2.exe"
& $kanataBin --check -c $kbdPath 2>&1 | Select-String "valid|error" | ForEach-Object { $_.Line }
if ($LASTEXITCODE -ne 0) { throw "kanata validation failed" }

Write-Host "Done." -ForegroundColor Green
