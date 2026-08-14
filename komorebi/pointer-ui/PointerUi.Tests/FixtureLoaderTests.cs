namespace PointerUi.Tests;

public sealed class FixtureLoaderTests
{
    [Fact]
    public void MissingLogicalIdentity_IsRejected()
    {
        AssertInvalid(
            """
            {
              "schemaVersion": 1,
              "name": "invalid",
              "mode": "UiHints",
              "desktopBounds": { "x": 0, "y": 0, "width": 100, "height": 100 },
              "dpi": 96,
              "pointer": null,
              "windows": [
                {
                  "processKey": "app.exe",
                  "windowRole": "app.main",
                  "bounds": { "x": 0, "y": 0, "width": 100, "height": 100 },
                  "isForeground": true,
                  "targets": [
                    {
                      "automationId": "",
                      "controlType": "Button",
                      "name": "",
                      "hierarchy": [],
                      "bounds": { "x": 10, "y": 10, "width": 20, "height": 20 },
                      "semanticAction": "Invoke"
                    }
                  ]
                }
              ],
              "grid": null
            }
            """,
            "logical identity");
    }

    [Fact]
    public void MissingRequiredCollection_IsRejected()
    {
        AssertInvalid(
            """
            {
              "schemaVersion": 1,
              "name": "invalid",
              "mode": "UiHints",
              "desktopBounds": { "x": 0, "y": 0, "width": 100, "height": 100 },
              "dpi": 96,
              "pointer": null,
              "grid": null
            }
            """,
            "not valid JSON");
    }

    private static void AssertInvalid(
        string json,
        string expectedMessage)
    {
        var path = Path.Combine(
            Path.GetTempPath(),
            $"pointer-ui-invalid-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, json);
        try
        {
            var exception = Assert.Throws<InvalidDataException>(
                () => FixtureLoader.Load(path));
            Assert.Contains(expectedMessage, exception.Message);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
