# Phase 0 validation sandbox

Throwaway kbd files used during Phase 0 to validate kanata mechanics before
committing to the per-app overlay refactor design. Kept in the repo as
evidence that the underlying assumptions hold.

## V1: macro emits correct chord sequence

`v1-macro.kbd` binds F13 to `(macro C-spc h)`.
`v1-input.txt` simulates pressing F13.

Run:

```pwsh
& ..\sim\kanata_simulated_input.exe -c v1-macro.kbd --sim v1-input.txt
```

Observed output (correct):

```
out:↓LCtrl
out:↓Space
out:↑Space
out:↑LCtrl
out:↓H
out:↑H
```

That's the psmux prefix sequence (Ctrl+Space chord, then standalone `h`).

Also verified end-to-end: temporary binding of `z (macro C-spc h)` in the
production WM layer, restart kanata, focus a Windows Terminal pane with
psmux running, press CapsLock+Z -> psmux pane moves left. Behaviorally
identical to the existing nav.left -> bridge -> SendInput path. Confirms
kanata's macro action emits via the same SendInput layer (which works for
non-elevated terminals).

## V2: layer switching swaps active bindings

`v2-changelayer.kbd` defines two layers (`base`, `alt`), each with a
different F13 binding.
`v2-input.txt` presses F13, switches to `alt`, presses F13, switches back,
presses F13.

The simulator's `ls:layer-name` directive uses the same `set_default_layer`
mechanism that kanata's TCP `ChangeLayer` invokes, so behavior validated in
the simulator transfers to production TCP.

Observed (correct):

```
push-msg: [Atom("from-base")]
layer-switch: alt (index 1)
push-msg: [Atom("from-alt")]
layer-switch: base (index 0)
push-msg: [Atom("from-base")]
```

## V3: LayerChange events fire on transitions

Validated separately by connecting to running production kanata's TCP port
and observing `{"LayerChange":{"new":"base"}}` arrive on connect. The
existing `LayerIndicatorRule` has been consuming these events in production,
which is independent evidence that the broadcast works.

## Notes for the refactor

- Kanata in this repo runs as `kanata_winIOv2.exe` which uses **LLHOOK +
  SendInput**, not the Interception driver. Kanata's `macro` action emits
  through the same SendInput layer. This means moving to macros does NOT
  give us UIPI immunity -- same restrictions as our previous bridge-side
  SendInput. The architectural benefits (single source of truth, no
  bridge-side keyboard sender, testable via simulator) still hold.
- Layer switching via TCP `ChangeLayer` swaps the *default* layer globally.
  Normal typing keys still pass through because the new layer doesn't map
  them (and `process-unmapped-keys yes` is set).
