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

        var labelLength = HintLabelSequence.RequiredLength(
            materialized.Count);
        if (_labels.Values.Any(
                label => label.Length != labelLength))
        {
            _labels.Clear();
        }
        var currentIds = materialized
            .Select(candidate => candidate.LogicalId)
            .ToHashSet();
        foreach (var removed in _labels.Keys
            .Where(id => !currentIds.Contains(id))
            .ToList())
        {
            _labels.Remove(removed);
        }
        var used = _labels.Values.ToHashSet(StringComparer.Ordinal);
        using var available = HintLabelSequence.Generate(
                labelLength)
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
        for (var length = 1; ; length++)
        {
            foreach (var label in Generate(
                prefix: string.Empty,
                remaining: length))
            {
                yield return label;
            }
        }
    }

    public static IEnumerable<string> Generate(int length)
    {
        if (length <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(length));
        }
        return Generate(
            prefix: string.Empty,
            remaining: length);
    }

    public static int RequiredLength(int count)
    {
        if (count < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(count));
        }

        var capacity = Symbols.Length;
        var length = 1;
        while (count > capacity)
        {
            capacity = checked(capacity * Symbols.Length);
            length++;
        }
        return length;
    }

    public static bool IsSymbol(string value) =>
        Symbols.Contains(
            value,
            StringComparer.Ordinal);

    private static IEnumerable<string> Generate(
        string prefix,
        int remaining)
    {
        if (remaining == 0)
        {
            yield return prefix;
            yield break;
        }

        foreach (var symbol in Symbols)
        {
            foreach (var label in Generate(
                prefix + symbol,
                remaining - 1))
            {
                yield return label;
            }
        }
    }
}
