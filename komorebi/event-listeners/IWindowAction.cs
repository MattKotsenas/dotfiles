namespace EventListeners;

/// <summary>
/// Abstraction over window operations so rules can be unit-tested without invoking
/// real Win32 calls or the komorebic CLI.
/// </summary>
public interface IWindowAction
{
    /// <summary>
    /// Toggles floating mode on whatever window is currently focused.
    /// Note: komorebic's toggle-float command is focused-window only; the caller is
    /// responsible for ensuring the desired window is focused before invoking this.
    /// </summary>
    void ToggleFloat();

    /// <summary>
    /// Sends WM_CLOSE to the specified window.
    /// </summary>
    void Close(long hwnd);
}
