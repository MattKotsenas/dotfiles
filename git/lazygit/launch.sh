#!/usr/bin/env bash
set -euo pipefail

here="$(dirname $0)"
here="$(cygpath -w $here)"

lazygit --use-config-file="$here/config.yml,$here/theme.lg_conf"
