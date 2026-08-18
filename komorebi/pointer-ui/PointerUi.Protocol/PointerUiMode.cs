using System.Text.Json.Serialization;

namespace PointerUi.Protocol;

[JsonConverter(typeof(PointerUiModeJsonConverter))]
public enum PointerUiMode
{
    Hidden,
    Indicator,
    UiHints,
    GridHints,
}

internal sealed class PointerUiModeJsonConverter()
    : JsonStringEnumConverter<PointerUiMode>(
        namingPolicy: null,
        allowIntegerValues: false);
