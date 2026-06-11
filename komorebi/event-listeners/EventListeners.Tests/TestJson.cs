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
    /// Wraps a window in a Show event content payload: <c>[reason, window_object]</c>.
    /// </summary>
    public static JsonElement ShowEventContent(string exe, string title, long hwnd, string klass = "Chrome_WidgetWin_1")
    {
        var json = $$"""
        ["WindowCreated", { "hwnd": {{hwnd}}, "title": {{JsonSerializer.Serialize(title)}}, "exe": {{JsonSerializer.Serialize(exe)}}, "class": {{JsonSerializer.Serialize(klass)}} }]
        """;
        return Parse(json);
    }

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

    private static string Window(WindowSpec w) => $$"""
        { "hwnd": {{w.Hwnd}}, "title": {{JsonSerializer.Serialize(w.Title)}}, "exe": {{JsonSerializer.Serialize(w.Exe)}}, "class": {{JsonSerializer.Serialize(w.Class ?? "Chrome_WidgetWin_1")}} }
        """;
}

internal sealed record WindowSpec(long Hwnd, string? Title, string? Exe, string? Class = null);
