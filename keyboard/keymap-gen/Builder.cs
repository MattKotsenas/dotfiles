namespace KeymapGen;

/// <summary>
/// Fluent builder for <see cref="Keymap"/>. Order matters only for readability;
/// <see cref="Build"/> validates structure and invariants.
/// </summary>
public sealed class KeymapBuilder
{
    private CapsConfig? _caps;
    private ReservedKeys? _reserved;
    private LayerBuilder? _wmBase;
    private readonly List<SubMode> _subModes = [];
    private readonly List<Overlay> _overlays = [];

    public KeymapBuilder Caps(int tapDanceMs = 250, int oneShotMs = 2000)
    {
        _caps = new CapsConfig(tapDanceMs, oneShotMs);
        return this;
    }

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

    public KeymapBuilder Overlay(string name, Action<LayerBuilder> configure)
    {
        var b = new LayerBuilder($"wm-{name}");
        configure(b);
        _overlays.Add(new Overlay(name, b.ToList(), b.LayerNote));
        return this;
    }

    public Keymap Build()
    {
        if (_caps is null) throw new InvalidOperationException("Caps() must be called.");
        if (_reserved is null) throw new InvalidOperationException("Reserve() must be called.");
        if (_wmBase is null) throw new InvalidOperationException("WmBase() must be called.");

        var keymap = new Keymap(
            _caps,
            _reserved,
            new Layer("wm-base", _wmBase.ToList(), _wmBase.LayerNote),
            _subModes,
            _overlays);

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
            steps.Add(el.Contains('-') ? new MacroChord(el) : new MacroKey(el));
        }
        _bindings.Add(new Binding(key, new MacroAction(steps)));
        return this;
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
    /// Intended for overlays where one external app prefix (e.g., <c>C-spc</c> for psmux)
    /// should be sent before the user's key.
    /// <para>
    /// Digit keys (<c>0</c>-<c>9</c>) emit <c>(unicode "&lt;digit&gt;")</c> as the second
    /// macro step instead of a bare key, because kanata's macro grammar interprets a
    /// standalone integer as a delay-in-ms.
    /// </para>
    /// <para>
    /// <paramref name="keys"/> defaults to printable letters/digits/symbols that are not
    /// reserved by wm-base; pass an explicit list to extend or override.
    /// </para>
    /// </summary>
    public LayerBuilder PrefixAll(string prefix, params string[] keys)
    {
        var actual = keys.Length > 0 ? keys : DefaultPrefixKeys;
        foreach (var key in actual)
        {
            if (key.Length == 1 && char.IsDigit(key[0]))
            {
                var steps = new MacroStep[] { new MacroChord(prefix), new MacroUnicode(key) };
                _bindings.Add(new Binding(key, new MacroAction(steps)));
            }
            else
            {
                Macro(key, prefix, key);
            }
        }
        return this;
    }

    private static readonly string[] DefaultPrefixKeys =
    [
        // Letters that are not reserved by wm-base (excludes a, s, d, f, e, w, r, p, q).
        "b", "c", "g", "h", "i", "j", "k", "l", "m", "n", "o", "t", "u", "v", "x", "y", "z",
        // Digits — emitted as (unicode "N") since kanata's macro grammar reads bare
        // integers as ms-delays.
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
