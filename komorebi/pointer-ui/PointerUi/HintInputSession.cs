namespace PointerUi;

public enum HintInputStatus
{
    Active,
    Completed,
    Cancelled,
}

public sealed record HintInputResult(
    HintInputStatus Status,
    string Prefix,
    bool Accepted,
    TargetSnapshot? Target,
    FakeAction? Action);

public sealed class HintInputSession
{
    private readonly IReadOnlyDictionary<string, TargetSnapshot>
        _targets;
    private string _prefix = string.Empty;
    private HintInputStatus _status;

    public HintInputSession(
        IEnumerable<TargetSnapshot> targets)
    {
        var materialized = targets.ToList();
        var duplicate = materialized
            .GroupBy(
                target => target.Label,
                StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null)
        {
            throw new ArgumentException(
                $"Duplicate hint label '{duplicate.Key}'.",
                nameof(targets));
        }
        _targets = materialized.ToDictionary(
            target => target.Label,
            StringComparer.Ordinal);
    }

    public HintInputResult Press(
        string key,
        bool pointOnly)
    {
        EnsureActive();
        var symbol = key.ToUpperInvariant();
        if (!HintLabelSequence.IsSymbol(symbol))
        {
            throw new ArgumentException(
                $"Unknown hint key '{key}'.",
                nameof(key));
        }

        var candidate = _prefix + symbol;
        var hasMatch = _targets.Keys
            .Any(label => label.StartsWith(
                candidate,
                StringComparison.Ordinal));
        if (!hasMatch)
        {
            return Result(accepted: false);
        }
        _prefix = candidate;
        if (!_targets.TryGetValue(
                _prefix,
                out var target))
        {
            return Result(accepted: true);
        }

        _status = HintInputStatus.Completed;
        return new HintInputResult(
            _status,
            _prefix,
            true,
            target,
            FakeActionPlanner.Plan(
                target,
                pointOnly));
    }

    public HintInputResult Backspace()
    {
        EnsureActive();
        if (_prefix.Length == 0)
        {
            return Result(accepted: false);
        }
        _prefix = _prefix[..^1];
        return Result(accepted: true);
    }

    public HintInputResult Cancel()
    {
        EnsureActive();
        _status = HintInputStatus.Cancelled;
        return Result(accepted: true);
    }

    private HintInputResult Result(bool accepted) =>
        new(
            _status,
            _prefix,
            accepted,
            null,
            null);

    private void EnsureActive()
    {
        if (_status is not HintInputStatus.Active)
        {
            throw new InvalidOperationException(
                "The hint input session is no longer active.");
        }
    }
}
