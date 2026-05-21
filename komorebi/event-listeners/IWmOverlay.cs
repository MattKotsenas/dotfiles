namespace EventListeners;

/// <summary>
/// Abstraction over the WM mode overlay so rules can be tested without real Win32 windows.
/// </summary>
public interface IWmOverlay
{
    void Show();
    void Hide();
}
