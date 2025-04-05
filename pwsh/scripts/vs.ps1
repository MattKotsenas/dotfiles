<#
.SYNOPSIS
Use vshwere to find Visual Studio, and start it with a dnvm fixup

.DESCRIPTION
This script is a workaround for the fact that Visual Studio does not respect the
DOTNET_ROOT environment variable, so we need to set the PATH environment variable
to include it.

Once that bug is fixed, we can remove this function and just call start directly.
#>
function vs {
    $where = vswhere -latest -property productPath
    Start-Process `
        -FilePath $where `
        -ArgumentList $args `
        -Environment @{ PATH = "$Env:DOTNET_ROOT;$Env:PATH" }
}
