# Unified Keyboard Navigation

A CapsLock-layer system for keyboard-driven window management on Windows,
built on [kanata] and [komorebi]. App-specific behavior (e.g. psmux pane nav
in Windows Terminal) layers on top via overlays selected by the focused app.

This directory contains the *source* of the keymap, expressed in a small C#
DSL that compiles to a flat `kanata.kbd`. The DSL exists because kanata can't
express overlays natively; we author overlays as we think about them and let
a compiler flatten them into layers kanata can run.

## Mental model

Tap CapsLock to enter "WM mode". The layer stack you're working in:

```
+---------------------------------+
| App overlay (if focused)        |  e.g. wm-terminal -- adds psmux nav on HJKL
+---------------------------------+
| Sub-modes (a / s / d / f / e)   |  e.g. wm-focus -- HJKL means focus, not move
+---------------------------------+
| wm-base (always)                |  reserved globals (r, p, tab, /) + sub-mode entries
+---------------------------------+
```

- Tap CAP once = **one-shot** WM mode (auto-exits after one action).
- Tap CAP twice = **toggle** WM mode (sticky; CAPS exits).
- In WM mode, the home-row letters `a/s/d/f/e/w` enter sub-modes.
- Sub-modes scope what HJKL means: focus / move / stack / resize / assemble / workspace.
- App overlays only bind keys *not* claimed by wm-base or sub-mode entries.
- Sub-mode entries (asdfwe) and globals (r/p/tab/q/g/`/`) are reserved and
  cannot be overridden by overlays.

A small overlay window in the top-left corner shows the current mode label
("WM" / "Focus" / "Term" / etc.) while WM mode is active.

## System architecture

```mermaid
graph LR
    subgraph "Authoring"
        DSL[ProductionKeymap.cs<br/>fluent DSL]
        Compiler[keymap-gen<br/>console app]
        DSL --> Compiler
    end

    subgraph "Generated artifacts"
        Compiler --> Kbd[kanata.kbd]
        Compiler --> Catalog[LayerCatalog.g.cs]
        Compiler -. future .-> Keymap[KEYMAP.md]
    end

    subgraph "Runtime"
        Kanata[kanata<br/>keyboard remapper]
        Bridge[event-listeners<br/>C# service]
        Komorebi[komorebi<br/>tiling WM]

        Kbd --> Kanata
        Catalog --> Bridge
        Kanata <-- "TCP<br/>bidirectional" --> Bridge
        Komorebi -- "focus events" --> Bridge
        Bridge -- "komorebic CLI" --> Komorebi
    end
```

### What kanata does

Owns key remapping. Reads `kanata.kbd` (compiler output) and intercepts the
keyboard. Two output paths:

1. **`push-msg`** — emits a string over TCP. Used for actions that invoke a
   running program (komorebic, wt). The bridge consumes these and dispatches.
2. **`macro`** — emits literal keystrokes. Used for app-specific shortcuts
   inside overlays (e.g., Ctrl+Space + h in wm-terminal for psmux). No bridge
   involvement; kanata writes directly to the focused window.

### What the bridge (event-listeners) does

Plain C# console app, hosted as a wpm service. Three responsibilities:

1. **`IntentDispatchRule`** — maps `wm.*` / `system.*` intent strings from
   kanata's `push-msg` to CliWrap commands (typically `komorebic <verb>`).
2. **`AppLayerRouter`** — subscribes to komorebi focus events, runs an
   ordered chain of C# routing rules, and sends `ChangeLayer` to kanata.
   The single rule today: `WindowsTerminal.exe → base-terminal`.
3. **`LayerIndicatorRule`** — subscribes to kanata `LayerChange` events,
   shows/hides the on-screen WM mode label.

All three share a single long-lived bidirectional TCP connection to kanata
(see `KanataEventListenerService`).

### What the compiler does

Lives in `keymap-gen/`. Reads `ProductionKeymap.cs` (the DSL) and emits:

- **`kanata/kanata.kbd`** — a flat set of kanata layers. For each declared
  overlay, the compiler generates `base-{name}`, `wm-{name}`, and
  `wm-{name}-toggle` layers, merging wm-base bindings + sub-mode entries +
  overlay-specific bindings (in that order, overlay last so it wins on conflicts).
- **`komorebi/event-listeners/Generated/LayerCatalog.g.cs`** — string
  constants for every layer name. The bridge router references these so a
  typo in a routing rule is a compile error.

Run via `keyboard/regen.ps1`.

#### Compile-time invariants enforced

- Overlay binds a reserved key (asdfwe, r/p/tab/...) → fail
- Same key bound twice in same layer → fail
- Macro references an unknown step kind → fail

### Why the DSL/bridge split

The DSL owns the **keymap** (what layers exist, what keys do what). The
bridge owns the **routing strategy** (which layer should be active for the
current focus).

The split exists because routing wants flexibility kanata can't express:
window title regex, focus class, time of day, etc. Bridge code is plain C#
and easy to evolve. Adding a simple app overlay is two small edits:

1. `ProductionKeymap.cs`: define the overlay layer with `.Overlay(...)`
2. `AppLayerRouter.cs`: add a one-line rule referencing the new
   `LayerCatalog.Base<Name>` constant

### Why intents vs macros

| | Intent (`push-msg`) | Macro |
|---|---|---|
| Path | kanata → TCP → bridge → CliWrap | kanata → keystrokes → focused window |
| Latency | sub-ms | sub-ms |
| Best for | invoking a program (komorebic) | sending shortcuts to the focused app |
| Example | `wm.focus.left` → `komorebic focus left` | `(macro C-spc h)` for psmux pane left |

Add a new intent when the action requires running a process. Add a macro when
it's a keystroke sequence the focused app understands natively.

## Focus tracking

The bridge listens to komorebi's `FocusChange` events. **Komorebi is the
single source of truth for focus.** When focus moves to an unmanaged window
(elevated process, transient dialog, unmanaged exe), komorebi doesn't fire
the event and the previously-set overlay stays active until the next managed
focus change. This is an accepted trade-off — the alternative (Win32
`SetWinEventHook` as a second focus source) creates two competing definitions
of focus and added complexity for an edge case.

## Layer naming convention

| Pattern | Purpose | Overlay UI? |
|---|---|---|
| `base-*` | Focus-context typing layers (just remap CAP) | Hidden |
| `wm` | Default one-shot WM mode | Shown ("WM") |
| `wm-toggle` | Default sticky WM mode | Shown ("WM •") |
| `wm-<name>` | Per-overlay one-shot WM (e.g. `wm-terminal`) | Shown ("Term") |
| `wm-<name>-toggle` | Per-overlay sticky WM | Shown ("Term •") |
| `wm-<submode>` | Sub-mode one-shot (e.g. `wm-focus`) | Shown ("Focus") |
| `wm-<submode>-toggle` | Sub-mode sticky | Shown ("Focus •") |

`LayerIndicatorRule.LabelForLayer` is the single source for the layer →
label mapping. `base-*` always returns null (no overlay).

## How to ...

### Add an app overlay

Example: open the Edge URL bar with `CAP+u` when Edge is focused.

1. Edit `keymap-gen/ProductionKeymap.cs`:
   ```csharp
   .Overlay("edge", b => b
       .Macro("u", "C-l"))    // CAP+u sends Ctrl+L when Edge is focused
   ```
2. Edit `komorebi/event-listeners/AppLayerRouter.cs` `DefaultRules`:
   ```csharp
   ctx => ctx.Exe == "msedge.exe" ? LayerCatalog.BaseEdge : null,
   ```
3. Run `keyboard/regen.ps1` (validates output with kanata, regenerates files).
4. `wpmctl restart kanata event-listeners`.

### Add a global command

Example: bind `CAP+z` to toggle workspace zoom.

1. Edit `keymap-gen/ProductionKeymap.cs`, add to `WmBase` and the
   `Reserve(global: [...])` list (so overlays can't claim `z`):
   ```csharp
   .Reserve(global: [..., "z"], ...)
   .WmBase(b => b
       ...
       .Intent("z", "wm.layout.toggle-zoom"))
   ```
2. Edit `komorebi/event-listeners/IntentDispatchRule.cs` `BuildCommandMap`:
   ```csharp
   map["wm.layout.toggle-zoom"] = () => Komorebic("toggle-zoom");
   ```
3. Add to `keyboard/INTENTS.md` under the Layout / mode table.
4. `keyboard/regen.ps1` + restart services.

### Add a routing rule that needs more than exe match

Example: route Edge to `base-edge`, but only when the URL bar contains
"github.com" — fallback to default otherwise.

Only the bridge changes. The DSL has no concept of routing.

```csharp
// AppLayerRouter.DefaultRules:
ctx => (ctx.Exe == "msedge.exe" && ctx.Title?.Contains("github.com") == true)
    ? LayerCatalog.BaseEdge : null,
```

### Debug a misbehaving layer

```pwsh
# Tail the bridge log -- focus changes, layer transitions, intent dispatches
Get-Content "$env:LOCALAPPDATA\wpm\logs\event-listeners.log" -Wait -Tail 30

# Tail kanata's log -- internal state machine messages
Get-Content "$env:LOCALAPPDATA\wpm\logs\kanata.log" -Wait -Tail 30

# Sniff kanata's TCP traffic directly (Powershell client):
# {"LayerChange":{"new":"base-default"}}
# ...
```

For unit tests of layer behavior (without disturbing your keyboard):

```pwsh
cd komorebi/event-listeners
dotnet test EventListeners.Tests --filter "Category=KanataHarness"
```

The harness uses a patched `kanata_simulated_input.exe` (see `kanata/sim/`)
to run kanata config logic in-memory. Tests live in
`EventListeners.Tests/Kanata/`.

## Service startup

Managed by [wpm]. Dependencies:

```
desktop (oneshot, autostart)
├── komorebi
├── komorebi-bar
├── kanata --port 9999
└── event-listeners
```

`whkd` is installed but disabled (the unit has `Autostart = false`); all
hotkeys live in kanata.

## Related files

- `keyboard/INTENTS.md` — vocabulary of `wm.*` / `system.*` intents
- `keyboard/KEYMAP.md` — per-key reference (auto-generated from the DSL)
- `keyboard/keymap-gen/ProductionKeymap.cs` — *the* source of truth for the keymap
- `keyboard/regen.ps1` — regenerate all artifacts
- `kanata/sandbox/` — Phase 0 validation kbd files (reference for kanata mechanics)
- `kanata/sim/` — patched simulator binary used by tests

[kanata]: https://github.com/jtroo/kanata
[komorebi]: https://github.com/LGUG2Z/komorebi
[wpm]: https://github.com/LGUG2Z/wpm
