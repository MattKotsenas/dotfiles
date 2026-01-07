namespace EventListeners.Models;

/// <summary>
/// Represents a window in the Komorebi state.
/// </summary>
public sealed class KomorebiWindow
{
    public long Hwnd { get; set; }
    public string? Title { get; set; }
    public string? Exe { get; set; }
    public string? Class { get; set; }
}
