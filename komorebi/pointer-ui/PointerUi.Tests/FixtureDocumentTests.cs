namespace PointerUi.Tests;

public sealed class FixtureDocumentTests
{
    [Fact]
    public void Write_CreatesParentDirectoryAndRoundTrips()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            $"pointer-ui-output-{Guid.NewGuid():N}");
        var path = Path.Combine(root, "nested", "fixture.json");
        var fixture = FixtureLoader.Load(Path.Combine(
            AppContext.BaseDirectory,
            "Fixtures",
            "indicator.json"));

        try
        {
            FixtureDocument.Write(
                path,
                fixture,
                overwrite: false);
            var loaded = FixtureLoader.Load(path);

            Assert.Equal(
                FixtureDocument.Serialize(fixture),
                FixtureDocument.Serialize(loaded));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }
}
