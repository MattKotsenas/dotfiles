using System.Security.Cryptography;
using System.Text;

namespace PointerUi;

public sealed class WindowRoleSession
{
    private const int MaxRoleHintLength = 80;

    private readonly Dictionary<string, string> _roles =
        new(StringComparer.Ordinal);

    public IReadOnlyDictionary<string, string> Assign(
        IEnumerable<WindowCapture> windows)
    {
        var used = _roles.Values.ToHashSet(StringComparer.Ordinal);
        var unassigned = windows
            .Where(window => !_roles.ContainsKey(window.SessionKey))
            .Select(window => new
            {
                Window = window,
                BaseRole = BaseRole(window.Root),
            })
            .OrderBy(item => item.BaseRole, StringComparer.Ordinal)
            .ThenBy(item => item.Window.SessionKey, StringComparer.Ordinal);

        foreach (var item in unassigned)
        {
            var role = item.BaseRole;
            if (used.Contains(role))
            {
                role = $"{role}@{SessionSuffix(item.Window.SessionKey)}";
                if (used.Contains(role))
                {
                    throw new InvalidOperationException(
                        $"Window role collision for '{role}'.");
                }
            }

            _roles.Add(item.Window.SessionKey, role);
            used.Add(role);
        }

        return _roles;
    }

    private static string BaseRole(ElementCapture root)
    {
        if (!string.IsNullOrWhiteSpace(root.AutomationId))
        {
            return $"{root.ControlType}#{SemanticText.Compact(root.AutomationId, MaxRoleHintLength)}";
        }
        if (!string.IsNullOrWhiteSpace(root.ClassName))
        {
            return $"{root.ControlType}.{SemanticText.Compact(root.ClassName, MaxRoleHintLength)}";
        }
        if (!string.IsNullOrWhiteSpace(root.Name))
        {
            return $"{root.ControlType}[{SemanticText.Compact(root.Name, MaxRoleHintLength)}]";
        }
        return root.ControlType;
    }

    private static string SessionSuffix(string sessionKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(sessionKey));
        return Convert.ToHexString(hash.AsSpan(0, 6))
            .ToLowerInvariant();
    }
}
