namespace EventListeners;

/// <summary>
/// Sends synthetic key inputs to the OS for inner navigation
/// (e.g., psmux prefix + direction). Injectable for testing.
/// </summary>
public interface IKeyboardSender
{
    /// <summary>
    /// Sends a key sequence. Each item is either:
    /// - A bare virtual key code (e.g., 0x48 for H)
    /// - A modifier+key chord (e.g., Ctrl+Space)
    /// </summary>
    void SendSequence(IReadOnlyList<KeyChord> sequence);
}

/// <summary>
/// Represents a single keypress, optionally with modifiers held down.
/// </summary>
public sealed record KeyChord(byte VirtualKey, KeyModifiers Modifiers = KeyModifiers.None);

[Flags]
public enum KeyModifiers
{
    None = 0,
    Ctrl = 1 << 0,
    Shift = 1 << 1,
    Alt = 1 << 2,
}
