using System.Text.Json.Serialization;

namespace PointerUi.Protocol;

public sealed record PointerUiRequest(
    [property: JsonRequired] int Version,
    [property: JsonRequired] long Sequence,
    [property: JsonRequired] PointerUiMode Mode,
    PointerUiInput? Input = null);

public sealed record PointerUiResponse(
    [property: JsonRequired] int Version,
    [property: JsonRequired] long Sequence,
    [property: JsonRequired] PointerUiMode Mode,
    [property: JsonRequired] bool Applied,
    [property: JsonRequired] int OverlayWindowCount,
    [property: JsonRequired] string? Error,
    [property: JsonRequired] bool RestartRequired,
    PointerUiInputResult? Input = null,
    long? SessionToken = null);

[JsonConverter(typeof(PointerUiInputKindJsonConverter))]
public enum PointerUiInputKind
{
    Key,
    Backspace,
    Cancel,
}

public sealed record PointerUiInput(
    [property: JsonRequired] PointerUiInputKind Kind,
    [property: JsonRequired] long SessionToken,
    string? Key = null);

[JsonConverter(typeof(PointerUiSessionStatusJsonConverter))]
public enum PointerUiSessionStatus
{
    Active,
    Completed,
    Cancelled,
}

public sealed record PointerUiInputResult(
    [property: JsonRequired] PointerUiSessionStatus Status,
    [property: JsonRequired] string Prefix,
    [property: JsonRequired] bool Accepted,
    [property: JsonRequired] string? SelectedLabel);

internal sealed class PointerUiInputKindJsonConverter()
    : JsonStringEnumConverter<PointerUiInputKind>(
        namingPolicy: null,
        allowIntegerValues: false);

internal sealed class PointerUiSessionStatusJsonConverter()
    : JsonStringEnumConverter<PointerUiSessionStatus>(
        namingPolicy: null,
        allowIntegerValues: false);
