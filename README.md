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

### Git

Configure HTTPS credentials in your global Git config for each authenticated host:

```sh
gh auth setup-git --hostname <host>
```

Git uses GitHub CLI's native credential helper; SSH uses existing keys.
Commit identity follows remote URLs through Git's conditional includes, with
repo-local settings taking precedence. Work identity belongs in ignored
`git/user.ghe.gitconfig`; Azure DevOps uses ignored `git/user.azdo.gitconfig`.
Supply these private files before installing with Dotbot.

Check the selected identity with `git config --show-origin --get user.email`.
Run the isolated configuration checks with `python -B tests/test_git_config.py`.

### VS

Captures extensions and keyboard shortcuts for Visual Studio.

To import / export extensions, use: https://marketplace.visualstudio.com/items?itemName=Loop8ack.ExtensionManager2022

To import / export keyboard settings, use: https://marketplace.visualstudio.com/items?itemName=JustinClareburtMSFT.VSShortcutsManager
