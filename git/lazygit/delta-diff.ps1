#!/usr/bin/env pwsh
git diff --no-index --no-ext-diff $args[1] $args[4] | delta
