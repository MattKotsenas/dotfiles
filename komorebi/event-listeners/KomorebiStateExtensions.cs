using System.Text.Json;
using EventListeners.Models;

namespace EventListeners;

/// <summary>
/// Helpers for traversing the Komorebi state JSON in a layer-agnostic way.
/// </summary>
public static class KomorebiStateExtensions
{
    /// <summary>
    /// Yields every window across all monitors and workspaces, both tiled containers and floating layer.
    /// Returns an empty sequence on malformed state rather than throwing.
    /// </summary>
    public static IEnumerable<KomorebiWindow> EnumerateAllWindows(this JsonElement state)
    {
        if (!TryGetElements(state, "monitors", out var monitors))
        {
            yield break;
        }

        foreach (var monitor in monitors)
        {
            if (!TryGetElements(monitor, "workspaces", out var workspaces))
            {
                continue;
            }

            foreach (var workspace in workspaces)
            {
                if (TryGetElements(workspace, "containers", out var containers))
                {
                    foreach (var container in containers)
                    {
                        if (TryGetElements(container, "windows", out var windows))
                        {
                            foreach (var window in windows)
                            {
                                var parsed = TryParseWindow(window);
                                if (parsed is not null)
                                {
                                    yield return parsed;
                                }
                            }
                        }
                    }
                }

                if (TryGetElements(workspace, "floating_windows", out var floatingWindows))
                {
                    foreach (var window in floatingWindows)
                    {
                        var parsed = TryParseWindow(window);
                        if (parsed is not null)
                        {
                            yield return parsed;
                        }
                    }
                }
            }
        }
    }

    /// <summary>
    /// Returns the hwnd of the currently focused window, or null on malformed state or no focus.
    /// </summary>
    public static long? GetFocusedHwnd(this JsonElement state)
    {
        var focusedWorkspace = GetFocusedWorkspace(state);
        if (focusedWorkspace is null)
        {
            return null;
        }

        var workspace = focusedWorkspace.Value;
        var layer = workspace.TryGetProperty("layer", out var layerElement)
            ? layerElement.GetString()
            : null;

        if (layer == "Floating")
        {
            return GetFocusedFromCollection(workspace, "floating_windows");
        }

        if (workspace.TryGetProperty("containers", out var containers) &&
            TryGetFocusedElement(containers, out var container) &&
            TryGetFocusedElement(container.GetProperty("windows"), out var window) &&
            window.TryGetProperty("hwnd", out var hwndElement))
        {
            return hwndElement.GetInt64();
        }

        return null;
    }

    private static JsonElement? GetFocusedWorkspace(JsonElement state)
    {
        if (!state.TryGetProperty("monitors", out var monitors) ||
            !TryGetFocusedElement(monitors, out var monitor))
        {
            return null;
        }

        if (!monitor.TryGetProperty("workspaces", out var workspaces) ||
            !TryGetFocusedElement(workspaces, out var workspace))
        {
            return null;
        }

        return workspace;
    }

    private static long? GetFocusedFromCollection(JsonElement workspace, string propertyName)
    {
        if (!workspace.TryGetProperty(propertyName, out var collection) ||
            !TryGetFocusedElement(collection, out var element) ||
            !element.TryGetProperty("hwnd", out var hwndElement))
        {
            return null;
        }

        return hwndElement.GetInt64();
    }

    private static bool TryGetFocusedElement(JsonElement collection, out JsonElement element)
    {
        element = default;

        if (collection.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!collection.TryGetProperty("focused", out var focusedElement) ||
            focusedElement.ValueKind != JsonValueKind.Number)
        {
            return false;
        }

        if (!collection.TryGetProperty("elements", out var elementsElement) ||
            elementsElement.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var index = focusedElement.GetInt32();
        if (index < 0 || index >= elementsElement.GetArrayLength())
        {
            return false;
        }

        element = elementsElement[index];
        return true;
    }

    private static bool TryGetElements(JsonElement parent, string propertyName, out JsonElement.ArrayEnumerator elements)
    {
        elements = default;

        if (parent.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!parent.TryGetProperty(propertyName, out var collection) ||
            collection.ValueKind != JsonValueKind.Object ||
            !collection.TryGetProperty("elements", out var elementsElement) ||
            elementsElement.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        elements = elementsElement.EnumerateArray();
        return true;
    }

    private static KomorebiWindow? TryParseWindow(JsonElement windowElement)
    {
        if (windowElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!windowElement.TryGetProperty("hwnd", out var hwndElement) ||
            hwndElement.ValueKind != JsonValueKind.Number)
        {
            return null;
        }

        return new KomorebiWindow
        {
            Hwnd = hwndElement.GetInt64(),
            Title = windowElement.TryGetProperty("title", out var title) ? title.GetString() : null,
            Exe = windowElement.TryGetProperty("exe", out var exe) ? exe.GetString() : null,
            Class = windowElement.TryGetProperty("class", out var cls) ? cls.GetString() : null,
        };
    }
}
