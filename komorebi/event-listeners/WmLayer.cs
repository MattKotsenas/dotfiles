namespace EventListeners;

/// <summary>
/// Which kanata layers put the keyboard in a WM mode, as opposed to a typing
/// layer where keys reach the focused application.
/// </summary>
public static class WmLayer
{
    public static bool IsWmMode(string layerName) =>
        layerName.Equals("wm", StringComparison.OrdinalIgnoreCase) ||
        layerName.StartsWith("wm-", StringComparison.OrdinalIgnoreCase);
}
