namespace PointerUi;

internal static class SemanticText
{
    public static string Compact(string value, int maxLength)
    {
        var compact = string.Join(
            ' ',
            value.Split(
                (char[]?)null,
                StringSplitOptions.RemoveEmptyEntries));
        return compact.Length <= maxLength
            ? compact
            : compact[..maxLength];
    }
}
