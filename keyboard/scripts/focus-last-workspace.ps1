#!/usr/bin/env pwsh
# Focus last workspace and sync all monitors to the same workspace index.
# Called from kanata WM layer (Tab key).

komorebic focus-last-workspace

$state = komorebic state | ConvertFrom-Json
$focusedMonitor = $state.monitors.focused
$targetWorkspace = $state.monitors.elements[$focusedMonitor].workspaces.focused

0..($state.monitors.elements.Count - 1) |
    Where-Object { $_ -ne $focusedMonitor } |
    ForEach-Object { komorebic focus-monitor-workspace $_ $targetWorkspace }
