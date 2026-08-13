using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests;

public sealed class MousemasterSupervisionConfigTests
{
    [Fact]
    public void Mousemaster_DoesNotRestartIndependentlyOfKanata()
    {
        var unit = File.ReadAllText(Path.Combine(
            TestPaths.RepoRoot,
            "wpm",
            "mousemaster.toml"));

        Assert.Contains("Restart = \"Never\"", unit);
        Assert.Contains(
            "Requires = [\"mousemaster\"]",
            File.ReadAllText(Path.Combine(
                TestPaths.RepoRoot,
                "wpm",
                "kanata.toml")));
    }
}
