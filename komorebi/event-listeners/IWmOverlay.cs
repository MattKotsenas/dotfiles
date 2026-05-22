namespace EventListeners;

/// <summary>
/// Abstraction over the WM mode overlay so rules can be tested without real Win32 windows.
/// </summary>
public interface IWmOverlay
{
    /// <summary>Show the overlay displaying <paramref name="label"/>.</summary>
    void Show(string label);

    /// <summary>Hide the overlay.</summary>
    void Hide();
}
