using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Recolours the focused window's border while a WM mode is active.
///
/// <para>
/// The border sits around whatever window the user is working in, on whatever
/// monitor that is, which is what makes it readable: it is already where they
/// are looking.
/// </para>
/// </summary>
public sealed class WmBorderIndicator : IEventRule
{
    /// <summary>Catppuccin Mocha Green. The keyboard is in a WM mode.</summary>
    internal static readonly BorderColour WmColour = new(166, 227, 161);

    /// <summary>
    /// What komorebi draws for each arrangement when no WM mode is active, from
    /// the Catppuccin Mocha theme in komorebi.json. Restoring means writing these
    /// back, since komorebi has no command to reapply a theme colour, and each
    /// arrangement has its own: writing one colour to all of them would leave
    /// stacked and monocled windows permanently miscoloured.
    /// </summary>
    private static readonly IReadOnlyDictionary<BorderWindowKind, BorderColour> RestingColours =
        new Dictionary<BorderWindowKind, BorderColour>
        {
            [BorderWindowKind.Single] = new(116, 199, 236),   // Sapphire
            [BorderWindowKind.Stack] = new(203, 166, 247),    // Mauve
            [BorderWindowKind.Monocle] = new(245, 194, 231),  // Pink
            [BorderWindowKind.Floating] = new(249, 226, 175), // Yellow
        };

    private readonly ILogger<WmBorderIndicator> _logger;
    private readonly IWindowAction _windowAction;

    // ProcessEvent is called from both the komorebi pipe reader and the kanata TCP
    // reader, so the state below is guarded.
    private readonly object _gate = new();

    private bool _wantWmColour;

    // What is believed to be on screen. Null until the first successful paint: a
    // restart can leave komorebi holding a colour this process never set, so
    // assuming anything would skip the paint that corrects it.
    private bool? _paintedWmColour;

    private bool _painting;

    /// <summary>Test seam: the paint loop started by the most recent layer change.</summary>
    internal Task? LastRecolour { get; private set; }

    public string Name => "WmBorderIndicator";

    public WmBorderIndicator(ILogger<WmBorderIndicator> logger, IWindowAction windowAction)
    {
        _logger = logger;
        _windowAction = windowAction;
    }

    /// <summary>The colour an arrangement takes outside any WM mode.</summary>
    internal static BorderColour RestingColour(BorderWindowKind kind) => RestingColours[kind];

    private static bool IsWmMode(string layerName) =>
        layerName.Equals("wm", StringComparison.OrdinalIgnoreCase) ||
        layerName.StartsWith("wm-", StringComparison.OrdinalIgnoreCase);

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KanataLayerChangeEvent e) return;

        lock (_gate)
        {
            _wantWmColour = IsWmMode(e.NewLayer);

            // Layer changes land on every CAP press and most do not move the
            // border. A paint already running will pick up the latest want when
            // it loops, so there is nothing to start.
            if (_painting) return;
            _painting = true;
        }

        LastRecolour = PaintLoopAsync();
    }

    /// <summary>
    /// Paints until the screen agrees with the newest layer. Looping rather than
    /// queueing a paint per layer change keeps a burst of changes from replaying
    /// every intermediate colour, and keeps waiters from piling up under a held
    /// key.
    /// </summary>
    private async Task PaintLoopAsync()
    {
        try
        {
            while (true)
            {
                bool want;
                lock (_gate)
                {
                    if (_paintedWmColour == _wantWmColour)
                    {
                        _painting = false;
                        return;
                    }

                    want = _wantWmColour;
                }

                if (!await PaintAsync(want))
                {
                    // Leaving _paintedWmColour untouched means the next layer
                    // change retries rather than treating the failure as done.
                    lock (_gate) { _painting = false; }
                    return;
                }

                lock (_gate) { _paintedWmColour = want; }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to recolour the window border");
            lock (_gate) { _painting = false; }
        }
    }

    private async Task<bool> PaintAsync(bool wmColour)
    {
        var results = await Task.WhenAll(RestingColours.Keys.Select(kind =>
            _windowAction.SetBorderColourAsync(kind, wmColour ? WmColour : RestingColours[kind])));

        if (results.All(ok => ok)) return true;

        _logger.LogWarning("Not every window border took the new colour");
        return false;
    }
}
