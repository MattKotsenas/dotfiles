namespace EventListeners;

/// <summary>
/// How the focused window is arranged. komorebi draws a separately coloured
/// border for each, so a colour meant to be seen has to be set for all of them.
/// </summary>
public enum BorderWindowKind
{
    Single,
    Stack,
    Monocle,
    Floating,
}
