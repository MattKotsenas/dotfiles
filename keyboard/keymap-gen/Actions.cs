namespace KeymapGen;

/// <summary>An action a key can trigger when pressed.</summary>
public abstract record KAction;

/// <summary>Emit a push-msg with the given intent name (e.g., wm.focus.left).</summary>
public sealed record IntentAction(string Name) : KAction;

/// <summary>Emit a sequence of keystrokes/delays/intents as a kanata macro.</summary>
public sealed record MacroAction(IReadOnlyList<MacroStep> Steps) : KAction;

/// <summary>
/// Escape hatch: emit this raw kanata Lisp text as the action. Use for kanata features
/// the DSL doesn't model (fork, switch, tap-hold, etc.).
/// </summary>
public sealed record KanataLiteral(string Lisp) : KAction;

/// <summary>A single step in a macro.</summary>
public abstract record MacroStep;

/// <summary>A chord (multiple keys pressed together) like "C-spc".</summary>
public sealed record MacroChord(string Chord) : MacroStep;

/// <summary>A single key tap.</summary>
public sealed record MacroKey(string Key) : MacroStep;

/// <summary>A delay in milliseconds.</summary>
public sealed record MacroDelay(int Ms) : MacroStep;

/// <summary>A nested push-msg with the given intent name.</summary>
public sealed record MacroIntent(string Name) : MacroStep;

/// <summary>Escape hatch: raw kanata Lisp text inside a macro.</summary>
public sealed record MacroLiteral(string Lisp) : MacroStep;
