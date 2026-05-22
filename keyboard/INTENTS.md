# Intent Vocabulary

Kanata emits intent strings via `push-msg`. The C# dispatcher in
event-listeners maps each intent to an action.

This separation means kanata config is implementation-agnostic and the
intent dispatch is fully unit-testable in C#.

## Naming convention

`<scope>.<verb>.<param>`

- `wm.*` - window management (komorebi) actions
- `nav.*` - context-sensitive navigation (app-aware, future)
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

### System
| Intent | Action |
|---|---|
| `system.cheatsheet` | open keymap reference (wt + glow) |

### Navigation (planned, app-aware)
| Intent | Action when... |
|---|---|
| `nav.left` | terminal: psmux pane left; chrome: history back; else: passthrough |
| `nav.down` | terminal: psmux pane down; chrome: next tab; else: passthrough |
| `nav.up` | terminal: psmux pane up; chrome: prev tab; else: passthrough |
| `nav.right` | terminal: psmux pane right; chrome: history forward; else: passthrough |
