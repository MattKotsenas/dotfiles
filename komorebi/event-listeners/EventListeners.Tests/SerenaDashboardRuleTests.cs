using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class SerenaDashboardRuleTests
{
    private const string SerenaExe = "python.exe";
    private const string SerenaTitle = "Serena Dashboard";

    private static SerenaDashboardRule CreateRule(out FakeWindowAction action)
    {
        action = new FakeWindowAction();
        return new SerenaDashboardRule(NullLogger<SerenaDashboardRule>.Instance, action);
    }

    [Fact]
    public void Show_SerenaDashboard_IsClosed()
    {
        var rule = CreateRule(out var action);
        Assert.Empty(action.ClosedHwnds); // precondition: nothing closed yet

        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.WindowEventContent(SerenaExe, SerenaTitle, 853592), null));

        Assert.Equal([853592L], action.ClosedHwnds);
    }

    [Fact]
    public void Show_SerenaDashboard_ExeMatchIsCaseInsensitive()
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.WindowEventContent("Python.exe", SerenaTitle, 100), null));

        Assert.Equal([100L], action.ClosedHwnds);
    }

    [Fact]
    public void Show_DifferentExeSameTitle_IsNotClosed()
    {
        // A browser window showing the localhost dashboard page would carry the
        // "Serena Dashboard" title but a different exe -- must not be closed.
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.WindowEventContent("msedge.exe", SerenaTitle, 100), null));

        Assert.Empty(action.ClosedHwnds);
    }

    [Fact]
    public void Show_PythonDifferentTitle_IsNotClosed()
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.WindowEventContent(SerenaExe, "Some Other Tool", 100), null));

        Assert.Empty(action.ClosedHwnds);
    }

    [Fact]
    public void NonShowEvent_SerenaContent_IsNotClosed()
    {
        // Only the Show event triggers a close; other event types are ignored
        // even if their content would otherwise match.
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            "FocusChange", TestJson.WindowEventContent(SerenaExe, SerenaTitle, 100), null));

        Assert.Empty(action.ClosedHwnds);
    }

    [Fact]
    public void Show_NullContent_IsIgnored()
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent("Show", null, null));

        Assert.Empty(action.ClosedHwnds);
    }

    [Fact]
    public void Show_MalformedContent_IsIgnored()
    {
        // Content that is not the expected [reason, window] array must not throw.
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.Parse("""{ "not": "a tuple" }"""), null));

        Assert.Empty(action.ClosedHwnds);
    }

    [Fact]
    public void Show_MultipleSerenaWindows_AllClosed()
    {
        var rule = CreateRule(out var action);

        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.WindowEventContent(SerenaExe, SerenaTitle, 100), null));
        rule.ProcessEvent(new KomorebiWindowEvent(
            "Show", TestJson.WindowEventContent(SerenaExe, SerenaTitle, 200), null));

        Assert.Equal([100L, 200L], action.ClosedHwnds.OrderBy(h => h).ToArray());
    }
}
