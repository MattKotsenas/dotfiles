using System.Security.Cryptography;
using System.Text;

namespace PointerUi;

public readonly record struct LogicalTargetId(string Value)
{
    public override string ToString() => Value;
}

public static class LogicalTargetIdentity
{
    public static LogicalTargetId Create(
        WindowFixture window,
        TargetFixture target)
    {
        var canonical = new StringBuilder();
        Append(canonical, "logical-target-v1");
        Append(canonical, Normalize(window.ProcessKey));
        Append(canonical, Normalize(window.WindowRole));
        Append(canonical, Normalize(target.ControlType));

        if (!string.IsNullOrWhiteSpace(target.AutomationId))
        {
            Append(canonical, "automation-id");
            Append(canonical, Normalize(target.AutomationId));
        }
        else
        {
            Append(canonical, "semantic-fallback");
            Append(canonical, Normalize(target.Name));
        }
        foreach (var segment in target.Hierarchy)
        {
            Append(canonical, Normalize(segment));
        }

        var hash = SHA256.HashData(
            Encoding.UTF8.GetBytes(canonical.ToString()));
        return new LogicalTargetId(
            $"target-v1-{Convert.ToHexString(hash.AsSpan(0, 12)).ToLowerInvariant()}");
    }

    private static void Append(StringBuilder builder, string value)
    {
        builder.Append(value.Length);
        builder.Append(':');
        builder.Append(value);
    }

    private static string Normalize(string value) =>
        string.Join(
                ' ',
                value.Normalize(NormalizationForm.FormKC)
                    .Split(
                        (char[]?)null,
                        StringSplitOptions.RemoveEmptyEntries))
            .ToUpperInvariant();
}
