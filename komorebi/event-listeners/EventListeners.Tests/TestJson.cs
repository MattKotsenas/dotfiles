using System.Text.Json;

namespace EventListeners.Tests;

/// <summary>
/// Helpers for building synthetic Komorebi state and event content as <see cref="JsonElement"/>
/// instances. Generated JSON mirrors the shape produced by <c>komorebic state</c> and
/// <c>komorebic subscribe-pipe</c> events.
/// </summary>
internal static class TestJson
{
    public static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    /// <summary>
    /// Wraps a window in window event content: <c>[reason, window_object]</c>, the
    /// shape shared by Show, FocusChange, and Destroy.
    /// </summary>
    public static JsonElement WindowEventContent(string exe, string title, long hwnd, string klass = "Chrome_WidgetWin_1", string reason = "WindowCreated")
    {
        var json = $$"""
        [{{JsonSerializer.Serialize(reason)}}, { "hwnd": {{hwnd}}, "title": {{JsonSerializer.Serialize(title)}}, "exe": {{JsonSerializer.Serialize(exe)}}, "class": {{JsonSerializer.Serialize(klass)}} }]
        """;
        return Parse(json);
    }

    /// <summary>
    /// Builds a komorebi state with several monitors, each carrying a <c>size</c> and
    /// a single workspace of tiled windows. Mirrors the real serialization, where a
    /// monitor's <c>size.right</c>/<c>size.bottom</c> hold width and height rather
    /// than the far edges.
    /// </summary>
    public static JsonElement MultiMonitorState(
        IEnumerable<MonitorSpec> monitors,
        int focusedMonitorIndex = 0)
    {
        var elements = string.Join(",", monitors.Select(m =>
        {
            var containers = string.Join(",", m.Windows.Select(w => $$"""
                { "windows": { "focused": 0, "elements": [{{Window(w)}}] } }
                """));

            var size = m.Bounds is { } b
                ? $$"""{ "left": {{b.Left}}, "top": {{b.Top}}, "right": {{b.Width}}, "bottom": {{b.Height}} }"""
                : "null";

            return $$"""
            {
              "size": {{size}},
              "workspaces": {
                "focused": 0,
                "elements": [
                  {
                    "layer": "Tiling",
                    "containers": { "focused": {{m.FocusedIndex}}, "elements": [{{containers}}] },
                    "monocle_container": null,
                    "floating_windows": { "focused": 0, "elements": [] }
                  }
                ]
              }
            }
            """;
        }));

        return Parse($$"""
        { "monitors": { "focused": {{focusedMonitorIndex}}, "elements": [{{elements}}] } }
        """);
    }

    private static string Window(WindowSpec w) => $$"""
        { "hwnd": {{w.Hwnd}}, "title": {{JsonSerializer.Serialize(w.Title)}}, "exe": {{JsonSerializer.Serialize(w.Exe)}}, "class": {{JsonSerializer.Serialize(w.Class ?? "Chrome_WidgetWin_1")}} }
        """;

    /// <summary>
    /// Builds a komorebi state JSON with the given tiled windows. Each tiled window becomes
    /// its own container. Optionally include floating windows, or a monocle'd container
    /// that takes focus precedence over the tiled containers.
    /// </summary>
    public static JsonElement State(
        IEnumerable<WindowSpec> tiled,
        IEnumerable<WindowSpec>? floating = null,
        int focusedContainerIndex = 0,
        int focusedFloatingIndex = 0,
        string layer = "Tiling",
        WindowSpec? monocle = null)
    {
        var tiledList = tiled.ToList();
        var floatingList = (floating ?? []).ToList();

        var containers = string.Join(",", tiledList.Select(w => $$"""
            {
              "windows": {
                "focused": 0,
                "elements": [{{Window(w)}}]
              }
            }
            """));

        var floatingElements = string.Join(",", floatingList.Select(Window));

        var monocleJson = monocle is null
            ? "null"
            : $$"""
              {
                "windows": {
                  "focused": 0,
                  "elements": [{{Window(monocle)}}]
                }
              }
              """;

        var json = $$"""
        {
          "monitors": {
            "focused": 0,
            "elements": [
              {
                "workspaces": {
                  "focused": 0,
                  "elements": [
                    {
                      "layer": {{JsonSerializer.Serialize(layer)}},
                      "containers": {
                        "focused": {{focusedContainerIndex}},
                        "elements": [{{containers}}]
                      },
                      "monocle_container": {{monocleJson}},
                      "floating_windows": {
                        "focused": {{focusedFloatingIndex}},
                        "elements": [{{floatingElements}}]
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
        """;

        return Parse(json);
    }
}

internal sealed record WindowSpec(long Hwnd, string? Title, string? Exe, string? Class = null);

internal sealed record MonitorSpec(MonitorBounds? Bounds, IReadOnlyList<WindowSpec> Windows, int FocusedIndex = 0);
