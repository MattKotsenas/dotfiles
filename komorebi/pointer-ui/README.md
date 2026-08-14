# Pointer UI fixture renderer

This project defines the testable rendering and decision core for the
keyboard-driven pointer UI, with no live input, hooks, or windowing.

`PointerUi` loads versioned desktop fixtures, derives logical target IDs,
assigns hint labels, builds overlay scenes, plans fake actions, and renders
scenes offscreen through WPF.

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

Received snapshots require human inspection before replacing their verified
counterparts.

The direct Magick.NET reference prevents Verify.ImageMagick from resolving to
its older vulnerable Magick.NET dependency.

## Policy

- Logical identity hashes semantic properties and hierarchy, never enumeration
  order or geometry.
- Labels persist across rescans within one `HintLabelSession`.
- Foreground targets prefer semantic actions, with point-only and coordinate
  fallback available.
- Background targets expose semantic actions only. Point-only and coordinate
  fallback are rejected.
