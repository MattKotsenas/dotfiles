#!/usr/bin/env bash
set -euo pipefail

config_dir="$(lazygit --print-config-dir)"
here="$(dirname $0)"
here="$(cygpath -w $here)"

lazygit --use-config-file="$config_dir/config.yml,$here/theme.lg_conf"
