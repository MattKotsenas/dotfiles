#!/usr/bin/env pwsh
# Personal launcher preference; preserve the saved arguments.
param([string]$Command, [string]$Directory)

$Command -replace '^copilot(?:\.exe)?(?=\s|$)', 'clod'
