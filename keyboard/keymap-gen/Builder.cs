namespace KeymapGen;

/// <summary>
/// Fluent builder for <see cref="Keymap"/>. Order matters only for readability;
/// <see cref="Build"/> validates structure and invariants.
/// </summary>
public sealed class KeymapBuilder
{
    private ReservedKeys? _reserved;
    private LayerBuilder? _wmBase;
    private PointerMode? _pointerMode;
    private readonly List<SubMode> _subModes = [];
    private readonly List<Overlay> _overlays = [];
    private readonly List<VirtualKey> _virtualKeys = [];

    public KeymapBuilder Reserve(string[]? global = null, string[]? subModeEntries = null)
    {
        _reserved = new ReservedKeys(global ?? [], subModeEntries ?? []);
        return this;
    }

    public KeymapBuilder WmBase(Action<LayerBuilder> configure)
    {
        var b = new LayerBuilder("wm-base");
        configure(b);
        _wmBase = b;
        return this;
    }

    public KeymapBuilder SubMode(string name, string entryKey, Action<LayerBuilder> configure)
    {
        var b = new LayerBuilder($"wm-{name}");
        configure(b);
        _subModes.Add(new SubMode(name, entryKey, b.ToList(), b.LayerNote));
        return this;
    }

    public KeymapBuilder PointerMode(
        string entryKey,
        string hintKey,
        Action<LayerBuilder> configure,
        PointerHintProvider hintProvider =
            PointerHintProvider.Mousemaster)
    {
        var layer = new LayerBuilder("pointer");
        configure(layer);
        _pointerMode = new PointerMode(
            entryKey,
            hintKey,
            layer.ToList(),
            layer.LayerNote,
            hintProvider);
        return this;
    }

    public KeymapBuilder Overlay(string name, Action<LayerBuilder> configure)
    {
        var b = new LayerBuilder($"wm-{name}");
        configure(b);
        _overlays.Add(new Overlay(name, b.ToList(), b.LayerNote));
        return this;
    }

    /// <summary>
    /// Declares a virtual key the bridge triggers over TCP. <paramref name="elements"/>
    /// uses the same chord/key shorthand as <see cref="LayerBuilder.Macro"/>.
    /// </summary>
    public KeymapBuilder VirtualKey(string name, params string[] elements)
    {
        var builder = new LayerBuilder($"vkey-{name}");
        builder.Macro(name, elements);
        _virtualKeys.Add(new VirtualKey(name, builder.ToList()[0].Action));
        return this;
    }

    public Keymap Build()
    {
        if (_reserved is null) throw new InvalidOperationException("Reserve() must be called.");
        if (_wmBase is null) throw new InvalidOperationException("WmBase() must be called.");

        var keymap = new Keymap(
            _reserved,
            new Layer("wm-base", _wmBase.ToList(), _wmBase.LayerNote),
            _pointerMode,
            _subModes,
            _overlays,
            _virtualKeys);

        Validator.Validate(keymap);
        return keymap;
    }
}

/// <summary>Builds a list of <see cref="Binding"/>s for a single layer/sub-mode/overlay.</summary>
public sealed class LayerBuilder(string name)
{
    private readonly List<Binding> _bindings = [];
    private string? _note;

    public string Name { get; } = name;

    /// <summary>
    /// Optional layer-level description rendered as a prose paragraph above the
    /// binding table in the cheatsheet. Set via <see cref="Describe(string)"/>
    /// before any binding is added.
    /// </summary>
    internal string? LayerNote => _note;

    /// <summary>
    /// Attach a human-readable description to the most recently configured thing:
    /// the last binding if one has been added, otherwise the layer itself.
    /// </summary>
    /// <remarks>
    /// Layer-level descriptions render as a prose paragraph above the table;
    /// binding-level descriptions render inline next to the action.
    /// </remarks>
    public LayerBuilder Describe(string text)
    {
        if (_bindings.Count == 0)
        {
            _note = text;
        }
        else
        {
            _bindings[^1] = _bindings[^1] with { Description = text };
        }
        return this;
    }

    public LayerBuilder Intent(string key, string intentName)
    {
        _bindings.Add(new Binding(key, new IntentAction(intentName)));
        return this;
    }

    /// <summary>
    /// Simple macro: emit the elements one after another. An element is either a
    /// chord (containing '-') like "C-spc" or a single key like "h".
    /// </summary>
    public LayerBuilder Macro(string key, params string[] elements)
    {
        var steps = new List<MacroStep>(elements.Length);
        foreach (var el in elements)
        {
            steps.Add(LooksLikeChord(el) ? new MacroChord(el) : new MacroKey(el));
        }
        _bindings.Add(new Binding(key, new MacroAction(steps)));
        return this;
    }

    /// <summary>
    /// True if <paramref name="el"/> matches the chord shorthand <c>X-Y</c> where
    /// X is a single-letter modifier (C/S/A/M, possibly chained as <c>C-S-y</c>).
    /// A bare punctuation key like <c>-</c> is NOT a chord.
    /// </summary>
    private static bool LooksLikeChord(string el)
    {
        var idx = el.IndexOf('-');
        if (idx <= 0 || idx == el.Length - 1) return false;
        var head = el[..idx];
        return head is "C" or "S" or "A" or "M";
    }

    /// <summary>Complex macro: configure steps via builder for delays, nested intents, literals.</summary>
    public LayerBuilder Macro(string key, Action<MacroBuilder> configure)
    {
        var b = new MacroBuilder();
        configure(b);
        _bindings.Add(new Binding(key, new MacroAction(b.ToList())));
        return this;
    }

    /// <summary>Bind keys "1".."(lastIndex - firstIndex + 1)" to intents formatted with the index.</summary>
    public LayerBuilder Workspaces(string intentTemplate, int firstIndex, int lastIndex)
    {
        if (!intentTemplate.Contains("{0}"))
            throw new ArgumentException("intentTemplate must contain {0} placeholder", nameof(intentTemplate));
        for (var i = firstIndex; i <= lastIndex; i++)
        {
            var displayKey = (i - firstIndex + 1).ToString();
            var intent = string.Format(System.Globalization.CultureInfo.InvariantCulture, intentTemplate, i);
            _bindings.Add(new Binding(displayKey, new IntentAction(intent)));
        }
        return this;
    }

    public LayerBuilder KanataLiteral(string key, string lisp)
    {
        _bindings.Add(new Binding(key, new KanataLiteral(lisp)));
        return this;
    }

    /// <summary>
    /// Bind every key in <paramref name="keys"/> to <c>(macro &lt;prefix&gt; &lt;key&gt;)</c>.
    /// Intended for overlays where one external app prefix (e.g., <c>C-b</c> for psmux)
    /// should be sent before the user's key.
    /// <para>
    /// Digit keys (<c>0</c>-<c>9</c>) route through <see cref="MacroUnmodKey"/> instead
    /// of a bare key, since kanata reads a bare integer macro step as a ms-delay.
    /// A command key matching the prefix key also uses <see cref="MacroUnmodKey"/> so
    /// kanata emits a second, standalone tap instead of absorbing it into the chord.
    /// </para>
    /// <para>
    /// <paramref name="keys"/> defaults to printable letters/digits/symbols that are not
    /// reserved by wm-base; pass an explicit list to extend or override.
    /// </para>
    /// </summary>
    public LayerBuilder PrefixAll(string prefix, params string[] keys)
    {
        var actual = keys.Length > 0 ? keys : DefaultPrefixKeys;
        var prefixKey = prefix[(prefix.LastIndexOf('-') + 1)..];

        foreach (var key in actual)
        {
            var requiresExplicitTap =
                key.Length == 1 && char.IsDigit(key[0]) ||
                key.Equals(prefixKey, StringComparison.OrdinalIgnoreCase);

            MacroStep commandKey = requiresExplicitTap
                ? new MacroUnmodKey(key)
                : new MacroKey(key);

            _bindings.Add(new Binding(
                key,
                new MacroAction([new MacroChord(prefix), commandKey])));
        }

        return this;
    }

    private static readonly string[] DefaultPrefixKeys =
    [
        // Letters that are not reserved by wm-base sub-mode entries (a/s/d/f/e/w).
        // Includes r and p which used to be wm-base globals but moved into the
        // wm-admin (CAP a) sub-mode in Phase 3 reorg — they're available again.
        "b", "c", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "t", "u", "v", "x", "y", "z",
        // Digits route through MacroUnmodKey (see its doc).
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
        // Common psmux / pain-control symbol bindings that are not wm-base reserved.
        // Excludes "/" (wm-base global cheatsheet) and "tab" (wm-base global).
        ",", ".", "\\", "-", "[", "]", ";",
    ];

    internal IReadOnlyList<Binding> ToList() => _bindings;
}

/// <summary>Builds a list of <see cref="MacroStep"/>s.</summary>
public sealed class MacroBuilder
{
    private readonly List<MacroStep> _steps = [];

    public MacroBuilder Chord(string chord) { _steps.Add(new MacroChord(chord)); return this; }
    public MacroBuilder Key(string key) { _steps.Add(new MacroKey(key)); return this; }
    public MacroBuilder Delay(int ms) { _steps.Add(new MacroDelay(ms)); return this; }
    public MacroBuilder Intent(string name) { _steps.Add(new MacroIntent(name)); return this; }
    public MacroBuilder Literal(string lisp) { _steps.Add(new MacroLiteral(lisp)); return this; }

    internal IReadOnlyList<MacroStep> ToList() => _steps;
}
