using System.Text.Json;
using System.Text.Json.Serialization;

namespace PointerUi;

public static class DiagnosticJson
{
    public static string Serialize(FixtureOutput output) =>
        JsonSerializer.Serialize(
            output,
            DiagnosticJsonContext.Default.FixtureOutput);

    public static string Serialize(
        IReadOnlyList<ActionPolicySnapshot> actions) =>
        JsonSerializer.Serialize(
            actions.ToList(),
            DiagnosticJsonContext.Default.ListActionPolicySnapshot);
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = true,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(FixtureOutput))]
[JsonSerializable(typeof(List<ActionPolicySnapshot>))]
internal sealed partial class DiagnosticJsonContext : JsonSerializerContext;
