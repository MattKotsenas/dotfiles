# Intent Vocabulary

Kanata emits intent strings via `push-msg`. The C# dispatcher in
event-listeners (`IntentDispatchRule`) maps each intent to a CliWrap command
(typically `komorebic <verb>`).

Intents are used only for actions that need to invoke a running program
(komorebic, wt). App-specific keystroke emission (psmux pane nav, browser
shortcuts, etc.) lives in overlay layers and is emitted as kanata macros --
NOT as intents.

## Naming convention

`<scope>.<verb>.<param>`

- `wm.*` - window management (komorebi) actions
- `system.*` - misc system actions

## Current vocabulary

### Focus
| Intent | Action |
|---|---|
| `wm.focus.left` | komorebic focus left |
| `wm.focus.down` | komorebic focus down |
| `wm.focus.up` | komorebic focus up |
| `wm.focus.right` | komorebic focus right |
| `wm.focus.cycle-next` | komorebic cycle-focus next |
| `wm.focus.last-workspace` | komorebic focus-last-workspace |

### Move
| Intent | Action |
|---|---|
| `wm.move.left` | komorebic move left |
| `wm.move.down` | komorebic move down |
| `wm.move.up` | komorebic move up |
| `wm.move.right` | komorebic move right |
| `wm.move.promote` | komorebic promote |

### Stack
| Intent | Action |
|---|---|
| `wm.stack.left` | komorebic stack left |
| `wm.stack.down` | komorebic stack down |
| `wm.stack.up` | komorebic stack up |
| `wm.stack.right` | komorebic stack right |
| `wm.stack.unstack` | komorebic unstack |
| `wm.stack.cycle-prev` | komorebic cycle-stack previous |
| `wm.stack.cycle-next` | komorebic cycle-stack next |

### Resize
| Intent | Action |
|---|---|
| `wm.resize.horizontal-decrease` | komorebic resize-axis horizontal decrease |
| `wm.resize.horizontal-increase` | komorebic resize-axis horizontal increase |
| `wm.resize.vertical-decrease` | komorebic resize-axis vertical decrease |
| `wm.resize.vertical-increase` | komorebic resize-axis vertical increase |

### Workspace
| Intent | Action |
|---|---|
| `wm.workspace.focus.0` ... `.7` | komorebic focus-workspaces N |
| `wm.workspace.move-to.0` ... `.7` | komorebic move-to-workspace N |

### Layout / mode
| Intent | Action |
|---|---|
| `wm.layout.flip-horizontal` | komorebic flip-layout horizontal |
| `wm.layout.flip-vertical` | komorebic flip-layout vertical |
| `wm.layout.toggle-float` | komorebic toggle-float |
| `wm.layout.toggle-monocle` | komorebic toggle-monocle |
| `wm.layout.retile` | komorebic retile |
| `wm.layout.toggle-pause` | komorebic toggle-pause |

### Window
| Intent | Action |
|---|---|
| `wm.window.manage` | komorebic manage (force-manage focused window) |

### System
| Intent | Action |
|---|---|
| `wm.system.reload` | wpmctl restart komorebi |
| `system.cheatsheet` | open keymap reference (wt + glow) |

## When NOT to add an intent

If the new behavior is "emit a key sequence to the focused app" (e.g. a
browser shortcut, an editor command), add an overlay binding in
`keymap-gen/ProductionKeymap.cs` using `.Macro(...)` instead of inventing
a new intent. Macros are emitted directly by kanata to the focused
window; they don't need a round trip through the bridge.
