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
    /// Moves the focused window to the given komorebi monitor index, landing on
    /// whichever workspace that monitor last had focused. False when the move failed.
    /// </summary>
    Task<bool> MoveToMonitorAsync(int monitorIndex);

    /// <summary>
    /// Promotes the focused window to the largest tile of its workspace.
    /// </summary>
    Task PromoteAsync();

    /// <summary>
    /// The window that currently holds the foreground, which is what komorebic's
    /// focus-relative commands will act on.
    /// </summary>
    long GetForegroundWindow();

    /// <summary>
    /// Sets the border colour komorebi draws for the given window arrangement.
    /// False when the command failed.
    /// </summary>
    Task<bool> SetBorderColourAsync(BorderWindowKind kind, BorderColour colour);
}
