using CliWrap;
using CliWrap.Buffered;

namespace EventListeners;

/// <summary>
/// Abstraction over process execution. Takes a CliWrap <see cref="Command"/>
/// (fully inspectable) and runs it. Inject a recording implementation in tests.
/// </summary>
public interface ICommandRunner
{
    Task<CommandResult> RunAsync(Command command, CancellationToken cancellationToken = default);

    /// <summary>
    /// Runs the command and buffers its output, for the rare cases where stdout is
    /// needed (e.g. resolving a path from <c>komorebic configuration</c>). Mirrors
    /// CliWrap's own <c>ExecuteAsync</c>/<c>ExecuteBufferedAsync</c> pairing.
    /// </summary>
    Task<BufferedCommandResult> RunBufferedAsync(Command command, CancellationToken cancellationToken = default);
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

    public Task<BufferedCommandResult> RunBufferedAsync(Command command, CancellationToken cancellationToken = default)
    {
        return command.ExecuteBufferedAsync(cancellationToken);
    }
}
