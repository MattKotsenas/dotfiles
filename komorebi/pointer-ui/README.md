# Pointer UI fixture renderer

This project defines the testable rendering and decision core for the
keyboard-driven pointer UI, with no live input, hooks, or windowing.

`PointerUi` loads versioned desktop fixtures, derives logical target IDs,
assigns hint labels, builds overlay scenes, plans fake actions, and renders
scenes offscreen through WPF.

`PointerUi.Windows` is the read-only adapter for top-level Win32 windows and
UI Automation control trees. `PointerUi.Recorder` projects one live capture
into the fixture schema. Neither project activates controls, changes
focus, creates overlays, or injects input.

`PointerUi.Tests` locks behavior three ways:

- Verify `*.verified.json` files record scene geometry, target identity, labels, and fake
  action decisions.
- Verify `*.verified.png` files hold the exact pixels produced by the same WPF
  renderer; tests compare them independently of PNG encoding.
- Explicit assertions cover identity stability and background-action policy.

Run the isolated suite:

```powershell
dotnet test .\PointerUi.slnx
```

The exact-pixel tests are tagged `Category=Visual` and require the dedicated VM's
interactive graphics session. Other development environments can run the
fixture, discovery, and policy tests without them:

```powershell
dotnet test .\PointerUi.slnx --filter "Category!=Visual"
```

Received snapshots require human inspection before replacing their verified
counterparts.

The direct Magick.NET reference prevents Verify.ImageMagick from resolving to
its older vulnerable Magick.NET dependency.

## VM-only recorder

The recorder enumerates interactive top-level windows on the current virtual
desktop. `WindowEligibility` owns the exact predicate. The adapter preserves
each window's DPI and limits UIA traversal. Projection excludes ambiguous
logical targets and writes diagnostics beside the fixture.

It refuses to capture unless the live-desktop flag is present:

```powershell
dotnet run --project .\PointerUi.Recorder\PointerUi.Recorder.csproj -- `
  --allow-live-desktop-capture `
  --output .\captures\desktop.json `
  --name desktop
```

Build, test, help, and invalid-argument paths never instantiate the
Windows/UIA adapter; only the capture command does. Run it only inside the
dedicated VM.

## VM acceptance harness

VM acceptance runs the recorder against deterministic foreground and
background WPF controls and proves logical IDs survive a real title change and
control reorder. The scenario includes semantic patterns, duplicate automation
IDs, a nameless control, and a coordinate-only foreground editor. The test
validates the fixture and diagnostics, then writes the rendered scene and frame
as artifacts. `PointerUi.Acceptance.slnx` remains separate from the normal
solution.

The test requires the environment and marker contract defined by
`AcceptanceContract`. The host script's comment-based help owns the default
marker path.

Run the host entrypoint:

```powershell
.\vm\Invoke-PointerUiAcceptance.ps1 `
  -RepoPathInVM C:\src\dotfiles
```

See its comment-based help for prerequisites and lifecycle options.

## Policy

- Logical identity hashes semantic properties and hierarchy, never enumeration
  order or geometry.
- Labels persist across rescans within one `HintLabelSession`.
- Foreground targets prefer semantic actions, with point-only and coordinate
  fallback available.
- Background targets expose semantic actions only. Point-only and coordinate
  fallback are rejected.
