namespace KeymapGen;

internal static class Validator
{
    public static void Validate(Keymap k)
    {
        var errors = new List<string>();

        // Sub-mode entry keys must each have a SubMode defined with that EntryKey
        foreach (var entry in k.Reserved.SubModeEntries)
        {
            if (!k.SubModes.Any(sm => sm.EntryKey == entry))
                errors.Add($"Reserved sub-mode entry '{entry}' has no SubMode definition.");
        }

        // SubMode entry keys must be in the reserved set
        foreach (var sm in k.SubModes)
        {
            if (!k.Reserved.SubModeEntries.Contains(sm.EntryKey))
                errors.Add($"SubMode '{sm.Name}' uses entry key '{sm.EntryKey}' which is not in Reserved.SubModeEntries.");
        }

        // SubMode and Overlay names must be unique
        var allLayerNames = k.SubModes.Select(s => s.Name).Concat(k.Overlays.Select(o => o.Name)).ToList();
        var dupes = allLayerNames.GroupBy(n => n).Where(g => g.Count() > 1).Select(g => g.Key);
        foreach (var d in dupes)
            errors.Add($"Layer name '{d}' is used by multiple SubModes/Overlays.");

        // No duplicate key in a single layer
        CheckNoDuplicates(k.WmBase, errors);
        foreach (var sm in k.SubModes) CheckNoDuplicates(new Layer(sm.Name, sm.Bindings), errors);
        foreach (var ov in k.Overlays) CheckNoDuplicates(new Layer(ov.Name, ov.Bindings), errors);

        // Overlays may not bind reserved keys
        var reserved = k.Reserved.Global.Concat(k.Reserved.SubModeEntries).ToHashSet();
        foreach (var ov in k.Overlays)
        {
            foreach (var b in ov.Bindings)
            {
                if (reserved.Contains(b.Key))
                    errors.Add($"Overlay '{ov.Name}' binds reserved key '{b.Key}'. Reserved keys are owned by wm-base and may not be overridden.");
            }
        }

        if (errors.Count > 0)
            throw new InvalidKeymapException(errors);
    }

    private static void CheckNoDuplicates(Layer l, List<string> errors)
    {
        var dupes = l.Bindings.GroupBy(b => b.Key).Where(g => g.Count() > 1).Select(g => g.Key);
        foreach (var d in dupes)
            errors.Add($"Layer '{l.Name}' binds key '{d}' more than once.");
    }
}

/// <summary>Thrown when <see cref="Validator.Validate"/> finds one or more invariant violations.</summary>
public sealed class InvalidKeymapException(IReadOnlyList<string> errors)
    : Exception("Keymap invariant violations:\n  - " + string.Join("\n  - ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}
