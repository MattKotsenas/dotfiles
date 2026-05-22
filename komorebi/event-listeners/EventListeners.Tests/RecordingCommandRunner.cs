using System.Collections.Concurrent;
using CliWrap;

namespace EventListeners.Tests;

/// <summary>
/// Records all Commands passed to RunAsync without executing them.
/// </summary>
public sealed class RecordingCommandRunner : ICommandRunner
{
    private readonly ConcurrentQueue<Command> _commands = new();

    public IReadOnlyCollection<Command> Commands => _commands.ToArray();

    public Task<CommandResult> RunAsync(Command command, CancellationToken cancellationToken = default)
    {
        _commands.Enqueue(command);
        return Task.FromResult(new CommandResult(0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow));
    }
}
