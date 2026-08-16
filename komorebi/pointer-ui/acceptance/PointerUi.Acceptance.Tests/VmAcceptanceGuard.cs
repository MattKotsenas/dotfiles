using PointerUi.Acceptance.Runner;

namespace PointerUi.Acceptance.Tests;

internal static class VmAcceptanceGuard
{
    public static string RequireArtifactsDirectory()
    {
        if (!string.Equals(
                Environment.GetEnvironmentVariable(
                    AcceptanceContract.VmEnabledVariable),
                "1",
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "VM acceptance is disabled. Set POINTER_UI_ACCEPTANCE_VM=1 only inside the dedicated VM.");
        }

        var markerPath = Environment.GetEnvironmentVariable(
            AcceptanceContract.MarkerPathVariable);
        if (string.IsNullOrWhiteSpace(markerPath)
            || !File.Exists(markerPath)
            || !string.Equals(
                File.ReadAllText(markerPath).Trim(),
                AcceptanceContract.MarkerContent,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "The dedicated VM marker is missing or invalid.");
        }

        var artifacts = Environment.GetEnvironmentVariable(
            AcceptanceContract.ArtifactsPathVariable);
        if (string.IsNullOrWhiteSpace(artifacts))
        {
            throw new InvalidOperationException(
                "POINTER_UI_ACCEPTANCE_ARTIFACTS is required.");
        }

        var path = Path.GetFullPath(artifacts);
        Directory.CreateDirectory(path);
        return path;
    }
}
