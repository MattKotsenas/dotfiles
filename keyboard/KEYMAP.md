# WM Layer Keymap

CapsLock = **tap** to toggle, **hold** for sustained WM mode.

## Directional (right hand HJKL)

| Sub-modifier | h | j | k | l |
|---|---|---|---|---|
| *(bare)* | *passthrough* | *passthrough* | *passthrough* | *passthrough* |
| **F** (focus) | focus left | focus down | focus up | focus right |
| **D** (displace) | move left | move down | move up | move right |
| **S** (stack) | stack left | stack down | stack up | stack right |
| **E** (expand) | shrink width | shrink height | grow height | grow width |

## Workspaces

| Key | Action |
|---|---|
| `1`-`8` | switch to workspace |
| `D` + `1`-`8` | move window to workspace |
| `Tab` | focus last workspace (multi-monitor sync) |

## Stack management

| Key | Action |
|---|---|
| `[` | cycle stack previous |
| `]` | cycle stack next |
| `\` | unstack |

## Standalone actions

| Key | Action |
|---|---|
| `t` | toggle float |
| `m` | toggle monocle |
| `r` | retile |
| `q` | promote |
| `x` | flip layout horizontal |
| `y` | flip layout vertical |
| `p` | toggle pause |
| `g` | cycle focus next |
| `?` | open this cheat sheet |

## Mode indicator

Borders brighten when WM mode is active (toggle only):

| Border | Normal | WM mode |
|---|---|---|
| Single | Sapphire `#74c7ec` | Saturated blue `#32d2f8` |
| Stack | Mauve `#cba6f7` | Saturated purple `#b478fa` |
| Unfocused | Surface1 `#45475a` | Surface2 `#50556e` |
