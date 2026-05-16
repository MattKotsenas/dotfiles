# dotfiles

dotfiles are how you personalize your system. These are mine.

Managed with [anishathalye/dotbot](https://github.com/anishathalye/dotbot).

## Install

On a fresh machine, install uv first so `install.ps1` has a Python to run dotbot (open a new shell after so `~/.local/bin` is on PATH):

```pwsh
winget install astral-sh.uv
uv python install --default 3.13
```

Then:

```pwsh
git clone
git submodule update --init --recursive
.\install.ps1
```

## Per tool notes

### VS

Captures extensions and keyboard shortcuts for Visual Studio.

To import / export extensions, use: https://marketplace.visualstudio.com/items?itemName=Loop8ack.ExtensionManager2022

To import / export keyboard settings, use: https://marketplace.visualstudio.com/items?itemName=JustinClareburtMSFT.VSShortcutsManager
