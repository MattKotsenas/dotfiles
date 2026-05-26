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
        MacroChord c => c.Chord,
        MacroKey k => k.Key,
        MacroDelay d => d.Ms.ToString(CultureInfo.InvariantCulture),
        MacroIntent i => $"(push-msg \"{i.Name}\")",
        MacroLiteral l => l.Lisp,
        MacroUnicode u => FormatUnicode(u),
        _ => throw new ArgumentException($"Unknown macro step type: {step.GetType().Name}"),
    };

    private static string FormatUnicode(MacroUnicode u)
    {
        // MacroUnicode is intended for typing single safe printables (currently
        // only digits via PrefixAll). Reject anything that would produce
        // malformed kanata Lisp until proper string-escaping is added.
        if (u.Char.Length != 1 || u.Char[0] is '"' or '\\' or '\n' or '\r')
        {
            throw new ArgumentException(
                $"MacroUnicode currently supports only a single safe character; got {u.Char.Length} char(s): \"{u.Char}\"");
        }
        return $"(unicode \"{u.Char}\")";
    }
}
