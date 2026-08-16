using PointerUi.Acceptance.Runner;

namespace PointerUi.Acceptance.Tests;

public sealed class VmAcceptanceGuardTests
{
    [Fact]
    public void MissingVmFlag_IsRejected()
    {
        using var environment = new AcceptanceEnvironment();

        var exception = Assert.Throws<InvalidOperationException>(
            VmAcceptanceGuard.RequireArtifactsDirectory);

        Assert.Contains("disabled", exception.Message);
    }

    [Fact]
    public void InvalidMarker_IsRejected()
    {
        using var environment = new AcceptanceEnvironment(
            enabled: true,
            markerContent: "not-the-marker");

        var exception = Assert.Throws<InvalidOperationException>(
            VmAcceptanceGuard.RequireArtifactsDirectory);

        Assert.Contains("marker", exception.Message);
    }

    private sealed class AcceptanceEnvironment : IDisposable
    {
        private readonly string? _enabled;
        private readonly string? _marker;
        private readonly string? _artifacts;
        private readonly string _root;

        public AcceptanceEnvironment(
            bool enabled = false,
            string markerContent = "")
        {
            _enabled = Environment.GetEnvironmentVariable(
                AcceptanceContract.VmEnabledVariable);
            _marker = Environment.GetEnvironmentVariable(
                AcceptanceContract.MarkerPathVariable);
            _artifacts = Environment.GetEnvironmentVariable(
                AcceptanceContract.ArtifactsPathVariable);
            _root = Path.Combine(
                Path.GetTempPath(),
                $"pointer-ui-guard-{Guid.NewGuid():N}");
            Directory.CreateDirectory(_root);
            var marker = Path.Combine(_root, "vm.marker");
            File.WriteAllText(marker, markerContent);
            Environment.SetEnvironmentVariable(
                AcceptanceContract.VmEnabledVariable,
                enabled ? "1" : null);
            Environment.SetEnvironmentVariable(
                AcceptanceContract.MarkerPathVariable,
                marker);
            Environment.SetEnvironmentVariable(
                AcceptanceContract.ArtifactsPathVariable,
                Path.Combine(_root, "artifacts"));
        }

        public void Dispose()
        {
            Environment.SetEnvironmentVariable(
                AcceptanceContract.VmEnabledVariable,
                _enabled);
            Environment.SetEnvironmentVariable(
                AcceptanceContract.MarkerPathVariable,
                _marker);
            Environment.SetEnvironmentVariable(
                AcceptanceContract.ArtifactsPathVariable,
                _artifacts);
            Directory.Delete(_root, recursive: true);
        }
    }
}
