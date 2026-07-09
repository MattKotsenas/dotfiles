using System.Globalization;
using System.Text;

namespace KeymapGen;

/// <summary>Formats a <see cref="KAction"/> into kanata Lisp.</summary>
internal static class ActionFormatter
{
    public static string Format(KAction action) => action switch
    {
        IntentAction i => FormatIntent(i),
        MacroAction m => FormatMacro(m),
        KanataLiteral l => l.Lisp,
        _ => throw new ArgumentException($"Unknown action type: {action.GetType().Name}"),
    };

    private static string FormatIntent(IntentAction i) =>
        $"(push-msg \"{i.Name}\")";

    private static string FormatMacro(MacroAction m)
    {
        var sb = new StringBuilder();
        sb.Append("(macro");
        foreach (var step in m.Steps)
        {
            sb.Append(' ');
            sb.Append(FormatStep(step));
        }
        sb.Append(')');
        return sb.ToString();
    }

    private static string FormatStep(MacroStep step) => step switch
    {
        MacroChord c => FormatChord(c),
        MacroKey k => k.Key,
        MacroDelay d => d.Ms.ToString(CultureInfo.InvariantCulture),
        MacroIntent i => $"(push-msg \"{i.Name}\")",
        MacroLiteral l => l.Lisp,
        MacroUnmodKey k => $"(unmod {k.Key})",
        _ => throw new ArgumentException($"Unknown macro step type: {step.GetType().Name}"),
    };

    /// <summary>
    /// Render a chord like <c>C-spc</c> as <c>(unmod lctl spc)</c> so any modifiers
    /// the user is physically holding (e.g. Shift while typing <c>:</c>) are
    /// released before the chord fires, then restored after. Without this, the
    /// physical Shift bleeds into the macro and turns the psmux prefix
    /// Ctrl+Space into Ctrl+Shift+Space (the Windows Terminal command palette
    /// trigger). The unmod wrapper also covers Alt/Ctrl/Win held during the chord.
    /// </summary>
    private static string FormatChord(MacroChord c)
    {
        var (mods, key) = ParseChord(c.Chord);
        var sb = new StringBuilder();
        sb.Append("(unmod");
        foreach (var m in mods) sb.Append(' ').Append(m);
        sb.Append(' ').Append(key).Append(')');
        return sb.ToString();
    }

    /// <summary>
    /// Parse a kanata chord shorthand like <c>C-spc</c> or <c>C-S-t</c> into
    /// (modifiers, key). Recognises the single-letter modifier prefixes used in
    /// this codebase: C (lctl), S (lsft), A (lalt), M (lmet).
    /// </summary>
    private static (List<string> Mods, string Key) ParseChord(string chord)
    {
        var parts = chord.Split('-');
        if (parts.Length < 2)
            throw new ArgumentException($"MacroChord must contain at least one '-' modifier prefix; got: {chord}");

        var mods = new List<string>(parts.Length - 1);
        for (var i = 0; i < parts.Length - 1; i++)
        {
            mods.Add(parts[i] switch
            {
                "C" => "lctl",
                "S" => "lsft",
                "A" => "lalt",
                "M" => "lmet",
                var p => throw new ArgumentException($"MacroChord prefix '{p}' is not a recognised modifier (expected C/S/A/M) in chord: {chord}"),
            });
        }
        return (mods, parts[^1]);
    }
}
