namespace PointerUi;

public sealed record TargetCandidate(
    WindowFixture Window,
    TargetFixture Target,
    LogicalTargetId LogicalId);

public sealed record LabeledTarget(
    WindowFixture Window,
    TargetFixture Target,
    LogicalTargetId LogicalId,
    string Label);

public sealed class HintLabelSession
{
    private readonly Dictionary<LogicalTargetId, string> _labels = [];

    public IReadOnlyList<LabeledTarget> Assign(
        IEnumerable<TargetCandidate> candidates)
    {
        var materialized = candidates.ToList();
        var duplicate = materialized
            .GroupBy(candidate => candidate.LogicalId)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null)
        {
            throw new InvalidOperationException(
                $"Duplicate logical target identity '{duplicate.Key}'.");
        }

        var used = _labels.Values.ToHashSet(StringComparer.Ordinal);
        using var available = HintLabelSequence.Generate()
            .Where(label => !used.Contains(label))
            .GetEnumerator();

        foreach (var candidate in materialized
            .Where(candidate => !_labels.ContainsKey(candidate.LogicalId))
            .OrderBy(candidate => candidate.LogicalId.Value, StringComparer.Ordinal))
        {
            if (!available.MoveNext())
            {
                throw new InvalidOperationException(
                    "The hint label space is exhausted.");
            }
            _labels.Add(candidate.LogicalId, available.Current);
        }

        return materialized
            .Select(candidate => new LabeledTarget(
                candidate.Window,
                candidate.Target,
                candidate.LogicalId,
                _labels[candidate.LogicalId]))
            .ToList();
    }
}

public static class HintLabelSequence
{
    private static readonly string[] Symbols =
    [
        "A", "S", "D", "F", "G", "H", "J", "K", "L",
        "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P",
        "Z", "X", "C", "V", "B", "N", "M",
    ];

    public static IEnumerable<string> Generate()
    {
        foreach (var symbol in Symbols)
        {
            yield return symbol;
        }

        foreach (var first in Symbols)
        {
            foreach (var second in Symbols)
            {
                yield return first + second;
            }
        }
    }
}
