<#
.SYNOPSIS
Use vshwere to find Visual Studio, and start it.

.DESCRIPTION
This script uses vswhere to find the latest version of Visual Studio installed on the system and starts it with the
provided arguments.

The main benefit of this over `Start-Process` directly is that we can pick which version of Visual Studio to use instead
of relying on default file associations (which always seem to be messed up for me when installing / uninstalling
preview versions).
#>
function vs {
    $where = vswhere -latest -property productPath
    Start-Process `
        -FilePath $where `
        -ArgumentList $args
}
