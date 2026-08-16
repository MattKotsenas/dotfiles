using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PointerUi;

public static class FixtureDocument
{
    public static string Serialize(DesktopFixture fixture) =>
        JsonSerializer.Serialize(
            fixture,
            FixtureWriterJsonContext.Default.DesktopFixture);

    public static string SerializeDiagnostics(
        IReadOnlyList<ProjectionDiagnostic> diagnostics) =>
        JsonSerializer.Serialize(
            diagnostics.ToList(),
            FixtureWriterJsonContext.Default.ListProjectionDiagnostic);

    public static void Write(
        string path,
        DesktopFixture fixture,
        bool overwrite) =>
        WriteText(path, Serialize(fixture), overwrite);

    public static void WriteDiagnostics(
        string path,
        IReadOnlyList<ProjectionDiagnostic> diagnostics,
        bool overwrite) =>
        WriteText(path, SerializeDiagnostics(diagnostics), overwrite);

    private static void WriteText(
        string path,
        string content,
        bool overwrite)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
        var mode = overwrite ? FileMode.Create : FileMode.CreateNew;
        using var stream = new FileStream(
            path,
            mode,
            FileAccess.Write,
            FileShare.None);
        using var writer = new StreamWriter(
            stream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.WriteLine(content);
    }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = true,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(DesktopFixture))]
[JsonSerializable(typeof(List<ProjectionDiagnostic>))]
internal sealed partial class FixtureWriterJsonContext : JsonSerializerContext;
