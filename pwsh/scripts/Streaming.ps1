# Streaming mode: prepares / restores desktop for livestream coding sessions.
# Exports Enable-Streaming and Disable-Streaming.

function Set-DoNotDisturb {
    param([ValidateSet("On","Off")][string]$State)

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Start-Process "ms-settings:notifications"
    Start-Sleep -Seconds 3

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $toggle = $root.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
            "SystemSettings_Notifications_QuietHours_MuteNotification_Enabled_ToggleSwitch")))

    if ($toggle) {
        $pattern = $toggle.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($pattern.Current.ToggleState -ne $State) {
            $pattern.Toggle()
            Start-Sleep -Seconds 1
        }
        Write-Host "Do Not Disturb: $($pattern.Current.ToggleState)"
    } else {
        Write-Warning "Could not find DND toggle in Settings"
    }

    Start-Sleep -Seconds 1
    Get-Process -Name "SystemSettings" -ErrorAction SilentlyContinue |
        Select-Object -First 1 |
        ForEach-Object { Stop-Process -Id $_.Id }
}

function Set-TerminalFontSize {
    param([int]$Size)

    $settingsPath = "D:\Projects\dotfiles\wt\settings.json"
    $json = Get-Content $settingsPath -Raw | ConvertFrom-Json

    if ($Size -gt 0) {
        $json.profiles.defaults.font | Add-Member -NotePropertyName "size" -NotePropertyValue $Size -Force
    } else {
        $json.profiles.defaults.font.PSObject.Properties.Remove("size")
    }

    $json | ConvertTo-Json -Depth 100 | Set-Content $settingsPath
}

function Set-VSCodeFontSize {
    param([int]$Size)

    $settingsPath = "D:\Projects\dotfiles\vscode\settings.json"
    $json = Get-Content $settingsPath -Raw | ConvertFrom-Json

    if ($Size -gt 0) {
        $json | Add-Member -NotePropertyName "editor.fontSize" -NotePropertyValue $Size -Force
    } else {
        $json.PSObject.Properties.Remove("editor.fontSize")
    }

    $json | ConvertTo-Json -Depth 100 | Set-Content $settingsPath
}

function Move-ChatWindows {
    param(
        [int]$FromMonitor, [int]$FromWorkspace,
        [int]$ToMonitor, [int]$ToWorkspace
    )

    $state = komorebic state 2>&1 | ConvertFrom-Json
    $ws = $state.monitors.elements[$FromMonitor].workspaces.elements[$FromWorkspace]
    $windowCount = 0
    foreach ($c in $ws.containers.elements) { $windowCount += $c.windows.elements.Count }

    if ($windowCount -eq 0) { return 0 }

    komorebic focus-monitor $FromMonitor
    Start-Sleep -Milliseconds 300
    komorebic focus-workspace $FromWorkspace
    Start-Sleep -Milliseconds 500

    for ($i = 0; $i -lt $windowCount; $i++) {
        komorebic cycle-focus next
        Start-Sleep -Milliseconds 300
        komorebic send-to-monitor-workspace $ToMonitor $ToWorkspace
        Start-Sleep -Milliseconds 300
    }

    return $windowCount
}

function Enable-Streaming {
    # Move chat apps to monitor 1
    komorebic clear-workspace-rules 0 1
    Start-Sleep -Milliseconds 500

    $moved = Move-ChatWindows -FromMonitor 0 -FromWorkspace 1 -ToMonitor 1 -ToWorkspace 0

    # Return focus to monitor 0 main
    komorebic focus-monitor 0
    Start-Sleep -Milliseconds 300
    komorebic focus-workspace 0

    if ($moved -gt 0) {
        Write-Host "Moved $moved chat windows to monitor 1."
    } else {
        Write-Host "No chat windows to move."
    }

    # Bump terminal font for readability (requires Terminal restart; symlink breaks hot-reload)
    Set-TerminalFontSize -Size 18
    Write-Host "Terminal font: 18pt (restart Terminal to apply)"

    # Bump VS Code font for readability
    Set-VSCodeFontSize -Size 18
    Write-Host "VS Code font: 18pt"

    # Enable Do Not Disturb
    Set-DoNotDisturb -State On

    # Pre-flight checklist
    Write-Host ""
    Write-Host "Pre-flight checklist:" -ForegroundColor Cyan
    Write-Host "  [ ] Close sensitive browser tabs"
    Write-Host "  [ ] Hide bookmarks bar"
    Write-Host "  [ ] Restart Terminal (font change requires it)"
    Write-Host "  [ ] Have water nearby"
    Write-Host "  [ ] Start Teams meeting"
    Write-Host "  [ ] Share screen + host audio"
}

function Disable-Streaming {
    # Move chat apps back to monitor 0
    $moved = Move-ChatWindows -FromMonitor 1 -FromWorkspace 0 -ToMonitor 0 -ToWorkspace 1

    # Restore workspace rules
    $chatApps = @("ms-teams.exe", "outlook.exe", "olk.exe", "slack.exe", "Discord.exe")
    foreach ($app in $chatApps) {
        komorebic workspace-rule exe $app 0 1
    }

    # Return focus to monitor 0 main
    komorebic focus-monitor 0
    Start-Sleep -Milliseconds 300
    komorebic focus-workspace 0

    if ($moved -gt 0) {
        Write-Host "Moved $moved windows back to chat."
    } else {
        Write-Host "No windows to move back."
    }

    # Restore terminal font (requires Terminal restart; symlink breaks hot-reload)
    Set-TerminalFontSize -Size 0
    Write-Host "Terminal font: default (restart Terminal to apply)"

    # Restore VS Code font
    Set-VSCodeFontSize -Size 0
    Write-Host "VS Code font: default"

    # Disable Do Not Disturb
    Set-DoNotDisturb -State Off
}
