#!/usr/bin/env pwsh
# Toggle komorebi border colors between normal and WM-mode intensity.
# Usage: wm-indicator.ps1 on|off
#
# Normal (Catppuccin Mocha):            WM mode (same hues, saturated):
#   single:    Sapphire #74c7ec          single:    #32d2f8
#   stack:     Mauve    #cba6f7          stack:     #b478fa
#   unfocused: Surface1 #45475a         unfocused:  #50556e

param([Parameter(Mandatory)][ValidateSet('on','off')][string]$Mode)

if ($Mode -eq 'on') {
    komorebic border-colour  50 210 248 --window-kind single
    komorebic border-colour 180 120 250 --window-kind stack
    komorebic border-colour  80  85 110 --window-kind unfocused
} else {
    komorebic border-colour 116 199 236 --window-kind single
    komorebic border-colour 203 166 247 --window-kind stack
    komorebic border-colour  69  71  90 --window-kind unfocused
}
