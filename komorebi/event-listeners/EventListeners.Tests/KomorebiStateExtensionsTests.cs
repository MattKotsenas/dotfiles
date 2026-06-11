namespace EventListeners.Tests;

public class KomorebiStateExtensionsTests
{
    [Fact]
    public void EnumerateAllWindows_TiledOnly_YieldsAllTiledWindows()
    {
        var state = TestJson.State(tiled: [
            new(1, "A", "a.exe"),
            new(2, "B", "b.exe"),
            new(3, "C", "c.exe"),
        ]);

        var hwnds = state.EnumerateAllWindows().Select(w => w.Hwnd).ToArray();

        Assert.Equal([1L, 2L, 3L], hwnds);
    }

    [Fact]
    public void EnumerateAllWindows_MixedTiledAndFloating_YieldsBoth()
    {
        var state = TestJson.State(
            tiled: [new(10, "tile1", "a.exe"), new(20, "tile2", "b.exe")],
            floating: [new(30, "float1", "c.exe")]);

        var hwnds = state.EnumerateAllWindows().Select(w => w.Hwnd).ToHashSet();

        Assert.Equal(new HashSet<long> { 10L, 20L, 30L }, hwnds);
    }

    [Fact]
    public void EnumerateAllWindows_EmptyWorkspaces_YieldsNothing()
    {
        var state = TestJson.State(tiled: []);

        Assert.Empty(state.EnumerateAllWindows());
    }

    [Fact]
    public void EnumerateAllWindows_MalformedState_YieldsNothing()
    {
        var malformed = TestJson.Parse("""{"not": "what we expected"}""");

        Assert.Empty(malformed.EnumerateAllWindows());
    }

    [Fact]
    public void EnumerateAllWindows_WindowMissingHwnd_Skipped()
    {
        var state = TestJson.Parse("""
        {
          "monitors": { "focused": 0, "elements": [{
            "workspaces": { "focused": 0, "elements": [{
              "layer": "Tiling",
              "containers": { "focused": 0, "elements": [{
                "windows": { "focused": 0, "elements": [
                  { "title": "no hwnd here", "exe": "x.exe" },
                  { "hwnd": 99, "title": "real", "exe": "y.exe" }
                ]}
              }]},
              "floating_windows": { "focused": 0, "elements": [] }
            }]}
          }]}
        }
        """);

        var hwnds = state.EnumerateAllWindows().Select(w => w.Hwnd).ToArray();

        Assert.Equal([99L], hwnds);
    }

    [Fact]
    public void GetFocusedHwnd_TiledFocused_ReturnsCorrectHwnd()
    {
        var state = TestJson.State(
            tiled: [new(11, "a", "a.exe"), new(22, "b", "b.exe"), new(33, "c", "c.exe")],
            focusedContainerIndex: 1);

        Assert.Equal(22L, state.GetFocusedHwnd());
    }

    [Fact]
    public void GetFocusedHwnd_FloatingLayerFocused_ReturnsFloatingHwnd()
    {
        var state = TestJson.State(
            tiled: [new(11, "tile", "a.exe")],
            floating: [new(44, "float1", "b.exe"), new(55, "float2", "c.exe")],
            focusedFloatingIndex: 1,
            layer: "Floating");

        Assert.Equal(55L, state.GetFocusedHwnd());
    }

    [Fact]
    public void GetFocusedHwnd_EmptyState_ReturnsNull()
    {
        var malformed = TestJson.Parse("""{}""");

        Assert.Null(malformed.GetFocusedHwnd());
    }

    [Fact]
    public void GetFocusedHwnd_MalformedState_ReturnsNull()
    {
        var bad = TestJson.Parse("""{"monitors": "this is wrong"}""");

        Assert.Null(bad.GetFocusedHwnd());
    }

    [Fact]
    public void GetFocusedHwnd_FocusedIndexOutOfRange_ReturnsNull()
    {
        var state = TestJson.Parse("""
        {
          "monitors": { "focused": 5, "elements": [{
            "workspaces": { "focused": 0, "elements": [{
              "layer": "Tiling",
              "containers": { "focused": 0, "elements": [] },
              "floating_windows": { "focused": 0, "elements": [] }
            }]}
          }]}
        }
        """);

        Assert.Null(state.GetFocusedHwnd());
    }

    [Fact]
    public void GetFocusedHwnd_MonocleActive_ReturnsMonocledWindowNotStaleContainerFocus()
    {
        // Komorebi keeps the previously tiled containers around when monocle is
        // active (along with monocle_container_restore_idx). The `focused` index
        // on containers can point at any window that was previously focused;
        // only monocle_container reflects what's actually on screen. Without
        // this precedence, AppLayerRouter would route to the stale container's
        // overlay (e.g. base-edge) instead of the visible monocle'd app.
        var state = TestJson.State(
            tiled: [new(11, "edge", "msedge.exe")],
            monocle: new WindowSpec(99, "psmux", "WindowsTerminal.exe"));

        Assert.Equal(99L, state.GetFocusedHwnd());
    }

    [Fact]
    public void EnumerateAllWindows_MonocleActive_IncludesMonocledWindow()
    {
        // The monocle'd window is in monocle_container, not containers.
        // AppLayerRouter looks up the focused hwnd in the enumeration to find
        // the exe -- if the monocle'd window isn't yielded, the lookup fails
        // and the focus context ends up with exe=null.
        var state = TestJson.State(
            tiled: [new(11, "edge", "msedge.exe")],
            monocle: new WindowSpec(99, "psmux", "WindowsTerminal.exe"));

        var hwnds = state.EnumerateAllWindows().Select(w => w.Hwnd).ToHashSet();

        Assert.Equal(new HashSet<long> { 11L, 99L }, hwnds);
    }

    [Fact]
    public void GetFocusedHwnd_MonocleActive_FloatingLayerStillTakesPrecedence()
    {
        // If the user has switched the workspace layer to Floating, focus is
        // on a floating window even if a monocle'd container exists in the
        // tiled stack.
        var state = TestJson.State(
            tiled: [new(11, "tile", "a.exe")],
            floating: [new(44, "float", "b.exe")],
            layer: "Floating",
            monocle: new WindowSpec(99, "psmux", "WindowsTerminal.exe"));

        Assert.Equal(44L, state.GetFocusedHwnd());
    }
}
