using CliWrap;

namespace EventListeners;

/// <summary>
/// Abstraction over process execution. Takes a CliWrap <see cref="Command"/>
/// (fully inspectable) and runs it. Inject a recording implementation in tests.
/// </summary>
public interface ICommandRunner
{
    Task<CommandResult> RunAsync(Command command, CancellationToken cancellationToken = default);
}

/// <summary>
/// Production implementation that executes the command via CliWrap.
/// </summary>
public sealed class CliWrapCommandRunner : ICommandRunner
{
    public Task<CommandResult> RunAsync(Command command, CancellationToken cancellationToken = default)
    {
        return command.ExecuteAsync(cancellationToken);
    }
}
