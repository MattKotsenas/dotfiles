namespace EventListeners;

/// <summary>
/// Abstraction over window and WM operations so rules can be unit-tested without
/// invoking real Win32 calls or the komorebic CLI.
/// </summary>
public interface IWindowAction
{
    /// <summary>
    /// Toggles floating mode on whatever window is currently focused.
    /// </summary>
    void ToggleFloat();

    /// <summary>
    /// Sends WM_CLOSE to the specified window.
    /// </summary>
    void Close(long hwnd);

    /// <summary>
    /// Sets the border color for a given window kind.
    /// </summary>
    void SetBorderColour(string windowKind, byte r, byte g, byte b);
}
