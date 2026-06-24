namespace EventListeners.Tests;

public class WindowFilterTests
{
    private static readonly IReadOnlySet<long> NothingTracked = new HashSet<long>();

    private static WindowInfo Window(
        long hwnd = 100,
        string title = "Some App",
        string exe = "someapp",
        int width = 1200,
        int height = 800,
        bool visible = true,
        bool cloaked = false,
        bool toolWindow = false,
        bool noActivate = false,
        bool child = false) => new()
        {
            Hwnd = hwnd,
            Title = title,
            Exe = exe,
            Width = width,
            Height = height,
            IsVisible = visible,
            IsCloaked = cloaked,
            IsToolWindow = toolWindow,
            IsNoActivate = noActivate,
            IsChild = child,
        };

    [Fact]
    public void NormalTopLevelWindow_IsManaged()
    {
        Assert.True(WindowFilter.ShouldManage(Window(), NothingTracked));
    }

    [Fact]
    public void AlreadyTracked_IsSkipped()
    {
        var tracked = new HashSet<long> { 100 };

        // precondition: the same window IS managed when komorebi isn't tracking it
        Assert.True(WindowFilter.ShouldManage(Window(hwnd: 100), NothingTracked));
        Assert.False(WindowFilter.ShouldManage(Window(hwnd: 100), tracked));
    }

    [Fact]
    public void ToolWindowOverlay_IsSkipped()
    {
        // Real case: the "Copilot Chat" flyout is a WS_EX_TOOLWINDOW + WS_EX_NOACTIVATE
        // popup. komorebi refuses to manage it; the filter weeds it out first.
        Assert.False(WindowFilter.ShouldManage(
            Window(title: "Copilot Chat", exe: "msedgewebview2", toolWindow: true, noActivate: true),
            NothingTracked));
    }

    [Fact]
    public void NoActivateWindow_IsSkipped()
    {
        Assert.False(WindowFilter.ShouldManage(Window(noActivate: true), NothingTracked));
    }

    [Theory]
    [InlineData("komorebi")]
    [InlineData("komorebi-bar")]
    [InlineData("KOMOREBI-BAR")] // exe match is case-insensitive
    public void KomorebiOwnWindows_AreSkipped(string exe)
    {
        Assert.False(WindowFilter.ShouldManage(Window(exe: exe), NothingTracked));
    }

    [Fact]
    public void Desktop_ProgramManager_IsSkipped()
    {
        Assert.False(WindowFilter.ShouldManage(
            Window(title: "Program Manager", exe: "explorer"), NothingTracked));
    }

    [Fact]
    public void NotVisible_IsSkipped() =>
        Assert.False(WindowFilter.ShouldManage(Window(visible: false), NothingTracked));

    [Fact]
    public void Cloaked_IsSkipped() =>
        Assert.False(WindowFilter.ShouldManage(Window(cloaked: true), NothingTracked));

    [Fact]
    public void BlankTitle_IsSkipped() =>
        Assert.False(WindowFilter.ShouldManage(Window(title: "   "), NothingTracked));

    [Fact]
    public void ChildWindow_IsSkipped() =>
        Assert.False(WindowFilter.ShouldManage(Window(child: true), NothingTracked));

    [Theory]
    [InlineData(WindowFilter.MinWidth - 1, WindowFilter.MinHeight)] // too narrow
    [InlineData(WindowFilter.MinWidth, WindowFilter.MinHeight - 1)] // too short
    public void TooSmall_IsSkipped(int width, int height)
    {
        // precondition: the exact minimum size IS managed, so the failures below
        // are due to the one-pixel shortfall and nothing else.
        Assert.True(WindowFilter.ShouldManage(
            Window(width: WindowFilter.MinWidth, height: WindowFilter.MinHeight), NothingTracked));
        Assert.False(WindowFilter.ShouldManage(Window(width: width, height: height), NothingTracked));
    }
}
