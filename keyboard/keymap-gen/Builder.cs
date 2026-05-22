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
        _subModes.Add(new SubMode(name, entryKey, b.ToList()));
        return this;
    }

    public KeymapBuilder Overlay(string name, Action<LayerBuilder> configure)
    {
        var b = new LayerBuilder($"wm-{name}");
        configure(b);
        _overlays.Add(new Overlay(name, b.ToList()));
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
            new Layer("wm-base", _wmBase.ToList()),
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

    public string Name { get; } = name;

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
