using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class RexSshWindowRuleTests
{
    private const string Terminal = "WindowsTerminal.exe";
    private const string Sentinel = "Rex SSH transport";

    [Theory]
    [InlineData("TitleUpdate", "ObjectNameChange", Terminal)]
    [InlineData("Show", "ObjectShow", "windowsterminal.exe")]
    public void TaggedWindowIsHiddenWithoutClosingOrActingOnForeground(string eventType, string reason, string exe)
    {
        var action = new FakeWindowAction { ForegroundWindow = 9999 };
        var rule = new RexSshWindowRule(NullLogger<RexSshWindowRule>.Instance, action);
        const long target = 8120;

        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.WindowEventContent(Terminal, "pwsh.exe", target), null));
        Assert.Empty(action.HideRequests);

        rule.ProcessEvent(new KomorebiWindowEvent(
            eventType, TestJson.WindowEventContent(exe, Sentinel, target, reason: reason), null));

        var hide = Assert.Single(action.HideRequests);
        Assert.Equal(target, hide.Hwnd);
        Assert.Equal(Terminal, hide.Exe, ignoreCase: true);
        Assert.Equal(Sentinel, hide.Title);
        Assert.Empty(action.ClosedHwnds);
    }

    [Theory]
    [InlineData("TitleUpdate", Terminal, "Rex SSH transport notes", 8120)]
    [InlineData("TitleUpdate", "pwsh.exe", Sentinel, 8120)]
    [InlineData("TitleUpdate", Terminal, Sentinel, 0)]
    [InlineData("Hide", Terminal, Sentinel, 8120)]
    public void OtherEventsDoNotHideOrCloseAWindow(string eventType, string exe, string title, long hwnd)
    {
        var action = new FakeWindowAction();
        var rule = new RexSshWindowRule(NullLogger<RexSshWindowRule>.Instance, action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            eventType, TestJson.WindowEventContent(exe, title, hwnd), null));

        Assert.Empty(action.HideRequests);
        Assert.Empty(action.ClosedHwnds);
    }
}
