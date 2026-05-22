namespace KeymapGen;

/// <summary>Tap-dance timeouts on CapsLock.</summary>
public sealed record CapsConfig(int TapDanceTimeoutMs, int OneShotTimeoutMs);

/// <summary>
/// Keys that are reserved by the WM system and may not be claimed by overlays.
/// </summary>
/// <param name="Global">
/// Keys that always do the same thing in wm-base regardless of sub-mode or
/// overlay context (e.g., r for retile).
/// </param>
/// <param name="SubModeEntries">
/// Keys that enter a sub-mode (e.g., f enters wm-focus). Overlays may not
/// override these.
/// </param>
public sealed record ReservedKeys(
    IReadOnlyList<string> Global,
    IReadOnlyList<string> SubModeEntries);

/// <summary>The whole keymap, ready to be emitted as kanata.kbd + adjacent artifacts.</summary>
public sealed record Keymap(
    CapsConfig Caps,
    ReservedKeys Reserved,
    Layer WmBase,
    IReadOnlyList<SubMode> SubModes,
    IReadOnlyList<Overlay> Overlays);

/// <summary>A named layer with explicit bindings. Unmapped keys are deadkeyed (___ XX) at the kanata level.</summary>
public sealed record Layer(string Name, IReadOnlyList<Binding> Bindings);

/// <summary>
/// A sub-mode is a layer entered by pressing <see cref="EntryKey"/> while in WM
/// mode. Sub-modes affect what HJKL etc. mean (focus vs move vs stack vs resize).
/// </summary>
public sealed record SubMode(string Name, string EntryKey, IReadOnlyList<Binding> Bindings);

/// <summary>
/// An overlay is a layer activated by the bridge based on the focused app
/// (e.g., wm-terminal when WindowsTerminal.exe is focused). Overlays add bindings
/// on uncommitted keys; they may not claim keys reserved by wm-base or sub-mode entries.
/// </summary>
public sealed record Overlay(string Name, IReadOnlyList<Binding> Bindings);

/// <summary>A single key → action binding.</summary>
public sealed record Binding(string Key, KAction Action);
