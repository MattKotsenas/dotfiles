namespace PointerUi.Host;

internal sealed class OverlayWindowManager
{
    private readonly List<OverlayWindow> _windows = [];

    public int Count => _windows.Count;

    public int Show(LiveOverlayFrame frame)
    {
        var replacements = new List<OverlayWindow>();
        try
        {
            foreach (var monitor in frame.Monitors)
            {
                var window = new OverlayWindow(
                    frame.Scene,
                    frame.VirtualBounds,
                    monitor.Bounds);
                replacements.Add(window);
                window.Show();
            }
        }
        catch
        {
            foreach (var window in replacements)
            {
                window.Close();
            }
            throw;
        }

        var previous = _windows.ToList();
        _windows.Clear();
        _windows.AddRange(replacements);
        foreach (var window in previous)
        {
            window.Close();
        }
        return _windows.Count;
    }

    public int Update(LiveOverlayFrame frame)
    {
        if (_windows.Count != frame.Monitors.Count
            || !_windows
                .Select(window => window.Bounds)
                .SequenceEqual(
                    frame.Monitors.Select(
                        monitor => monitor.Bounds)))
        {
            return Show(frame);
        }

        foreach (var window in _windows)
        {
            window.Update(
                frame.Scene,
                frame.VirtualBounds);
        }
        return _windows.Count;
    }

    public int Hide()
    {
        foreach (var window in _windows)
        {
            window.Close();
        }
        _windows.Clear();
        return 0;
    }
}
