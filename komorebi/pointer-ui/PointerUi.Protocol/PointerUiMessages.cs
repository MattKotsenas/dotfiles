using System.Text.Json.Serialization;

namespace PointerUi.Protocol;

public sealed record PointerUiRequest(
    [property: JsonRequired] int Version,
    [property: JsonRequired] long Sequence,
    [property: JsonRequired] PointerUiMode Mode);

public sealed record PointerUiResponse(
    [property: JsonRequired] int Version,
    [property: JsonRequired] long Sequence,
    [property: JsonRequired] PointerUiMode Mode,
    [property: JsonRequired] bool Applied,
    [property: JsonRequired] int OverlayWindowCount,
    [property: JsonRequired] string? Error,
    [property: JsonRequired] bool RestartRequired);
