using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PointerUi;

public enum FixtureMode
{
    Indicator,
    UiHints,
    GridHints,
}

public enum SemanticActionKind
{
    None,
    Invoke,
    Toggle,
    Select,
}

public readonly record struct PixelPoint(double X, double Y);

public readonly record struct PixelRect(
    double X,
    double Y,
    double Width,
    double Height)
{
    [JsonIgnore]
    public PixelPoint Center => new(X + Width / 2, Y + Height / 2);
}

public sealed record DesktopFixture(
    int SchemaVersion,
    string Name,
    FixtureMode Mode,
    PixelRect DesktopBounds,
    double Dpi,
    PixelPoint? Pointer,
    [property: JsonRequired] IReadOnlyList<WindowFixture> Windows,
    GridFixture? Grid);

public sealed record WindowFixture(
    string ProcessKey,
    string WindowRole,
    PixelRect Bounds,
    double Dpi,
    bool IsForeground,
    [property: JsonRequired] IReadOnlyList<TargetFixture> Targets);

public sealed record TargetFixture(
    string AutomationId,
    string ControlType,
    string Name,
    [property: JsonRequired] IReadOnlyList<string> Hierarchy,
    PixelRect Bounds,
    SemanticActionKind SemanticAction);

public sealed record GridFixture(int Rows, int Columns);

public static class FixtureLoader
{
    public static DesktopFixture Load(string path)
    {
        DesktopFixture fixture;
        try
        {
            fixture = JsonSerializer.Deserialize(
                File.ReadAllText(path),
                FixtureJsonContext.Default.DesktopFixture)
                ?? throw Invalid(path, "did not contain a desktop");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException(
                $"Fixture '{path}' is not valid JSON.",
                exception);
        }

        if (fixture.SchemaVersion != 1)
        {
            throw Invalid(
                path,
                $"uses unsupported schema {fixture.SchemaVersion}");
        }
        if (string.IsNullOrWhiteSpace(fixture.Name))
        {
            throw Invalid(path, "has no name");
        }
        if (fixture.DesktopBounds.Width <= 0
            || fixture.DesktopBounds.Height <= 0)
        {
            throw Invalid(path, "has invalid desktop bounds");
        }
        if (fixture.Dpi <= 0)
        {
            throw Invalid(path, "has invalid DPI");
        }
        foreach (var window in fixture.Windows)
        {
            if (string.IsNullOrWhiteSpace(window.ProcessKey)
                || string.IsNullOrWhiteSpace(window.WindowRole))
            {
                throw Invalid(path, "has a window without logical identity");
            }
            if (window.Bounds.Width <= 0 || window.Bounds.Height <= 0)
            {
                throw Invalid(path, "has invalid window bounds");
            }
            if (window.Dpi <= 0)
            {
                throw Invalid(path, "has invalid window DPI");
            }
            foreach (var target in window.Targets)
            {
                if (string.IsNullOrWhiteSpace(target.ControlType)
                    || target.Hierarchy.Count == 0
                    || target.Hierarchy.Any(string.IsNullOrWhiteSpace)
                    || (string.IsNullOrWhiteSpace(target.AutomationId)
                        && string.IsNullOrWhiteSpace(target.Name)))
                {
                    throw Invalid(path, "has a target without logical identity");
                }
                if (target.Bounds.Width <= 0 || target.Bounds.Height <= 0)
                {
                    throw Invalid(path, "has invalid target bounds");
                }
            }
        }

        return fixture;
    }

    private static InvalidDataException Invalid(
        string path,
        string reason) =>
        new($"Fixture '{path}' {reason}.");
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    RespectNullableAnnotations = true,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(DesktopFixture))]
internal sealed partial class FixtureJsonContext : JsonSerializerContext;
