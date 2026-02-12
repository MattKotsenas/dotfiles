#!/usr/bin/env pwsh

# From https://github.com/jesseduffield/lazygit/pull/4941/changes

$old = $args[1].Replace('\', '/')
$new = $args[4].Replace('\', '/')
$path = $args[0]
git diff --no-index --no-ext-diff $old $new
  | %{
      if ($old -ne 'nul') { $_ = $_.Replace($old, $path) }
      if ($new -ne 'nul') { $_ = $_.Replace($new, $path) }
      $_
    }
  | delta --hyperlinks
