using System.Collections.Concurrent;
using CliWrap;
using CliWrap.Buffered;

namespace EventListeners.Tests;

/// <summary>
/// Records all Commands passed to RunAsync without executing them.
/// </summary>
public sealed class RecordingCommandRunner : ICommandRunner
{
    private readonly ConcurrentQueue<Command> _commands = new();

    public IReadOnlyCollection<Command> Commands => _commands.ToArray();

    /// <summary>
    /// Stdout handed back from <see cref="RunBufferedAsync"/> (e.g. a resolved config path).
    /// </summary>
    public string BufferedStandardOutput { get; set; } = string.Empty;

    public Task<CommandResult> RunAsync(Command command, CancellationToken cancellationToken = default)
    {
        _commands.Enqueue(command);
        return Task.FromResult(new CommandResult(0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow));
    }

    public Task<BufferedCommandResult> RunBufferedAsync(Command command, CancellationToken cancellationToken = default)
    {
        _commands.Enqueue(command);
        return Task.FromResult(new BufferedCommandResult(
            0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, BufferedStandardOutput, string.Empty));
    }
}
