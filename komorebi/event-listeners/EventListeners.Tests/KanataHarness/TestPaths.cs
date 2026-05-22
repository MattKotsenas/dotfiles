namespace EventListeners.Tests.KanataHarness;

/// <summary>
/// Resolves paths to the kanata binary and config for harness tests.
/// Walks up from the test assembly to find the dotfiles repo root.
/// </summary>
public static class TestPaths
{
    private static readonly Lazy<string> _repoRoot = new(FindRepoRoot);

    public static string RepoRoot => _repoRoot.Value;

    public static string SimulatorBinary =>
        Path.Combine(RepoRoot, "kanata", "sim", "kanata_simulated_input.exe");

    public static string ProductionConfig =>
        Path.Combine(RepoRoot, "kanata", "kanata.kbd");

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "install.conf.yaml")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }

        throw new InvalidOperationException(
            $"Could not find dotfiles repo root walking up from {AppContext.BaseDirectory}");
    }
}
