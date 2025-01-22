function Invoke-Eza
{
    # Intentionally not an advanced function to avoid dealing with bound / unbound parameters
    eza --icons --all --time-style long-iso --hyperlink --git --classify @args
}

function Invoke-EzaLong
{
    # Intentionally not an advanced function to avoid dealing with bound / unbound parameters
    Invoke-Eza --long @args
}

Set-Alias ls -Value Invoke-Eza
Set-Alias ll -Value Invoke-EzaLong
