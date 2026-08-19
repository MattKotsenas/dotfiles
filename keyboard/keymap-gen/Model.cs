namespace KeymapGen;

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
    ReservedKeys Reserved,
    Layer WmBase,
    PointerMode? PointerMode,
    IReadOnlyList<SubMode> SubModes,
    IReadOnlyList<Overlay> Overlays,
    IReadOnlyList<VirtualKey> VirtualKeys);

/// <summary>
/// A kanata virtual key the bridge triggers over TCP with <c>ActOnFakeKey</c>.
/// A chord defined here is emitted by kanata, which applies its own
/// <c>unmod</c> handling, so modifiers the user is physically holding cannot
/// alter it. A chord the bridge injected itself would race those modifiers.
/// </summary>
public sealed record VirtualKey(string Name, KAction Action);

/// <summary>A named layer with explicit bindings. Unmapped keys are deadkeyed (___ XX) at the kanata level.</summary>
public sealed record Layer(string Name, IReadOnlyList<Binding> Bindings, string? Note = null);

/// <summary>
/// A sub-mode is a layer entered by pressing <see cref="EntryKey"/> while in WM
/// mode. Sub-modes affect what HJKL etc. mean (focus vs move vs stack vs resize).
/// </summary>
public sealed record SubMode(string Name, string EntryKey, IReadOnlyList<Binding> Bindings, string? Note = null);

/// <summary>
/// A persistent pointer layer entered from any WM context. It remains active
/// until Caps/Escape and follows the latest focused-app context.
/// </summary>
public sealed record PointerMode(
    string EntryKey,
    string HintKey,
    IReadOnlyList<Binding> Bindings,
    string? Note = null,
    PointerHintProvider HintProvider =
        PointerHintProvider.Mousemaster);

public enum PointerHintProvider
{
    Mousemaster,
    PointerUi,
}

/// <summary>
/// An overlay is a layer activated by the bridge based on the focused app
/// (e.g., wm-terminal when WindowsTerminal.exe is focused). Overlays add bindings
/// on uncommitted keys; they may not claim keys reserved by wm-base or sub-mode entries.
/// </summary>
public sealed record Overlay(string Name, IReadOnlyList<Binding> Bindings, string? Note = null);

/// <summary>
/// A single key → action binding. <paramref name="Description"/> is an optional
/// human-readable label surfaced by the cheatsheet emitter (e.g., "toggle mute"
/// for a Teams macro); kanata emission ignores it.
/// </summary>
public sealed record Binding(string Key, KAction Action, string? Description = null);
