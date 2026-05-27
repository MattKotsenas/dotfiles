using System.Collections.Concurrent;
using CliWrap;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class KomorebiEventListenerServiceTests
{
    // Use very short delays so reconnect-driven tests finish in milliseconds, not seconds.
    private static readonly TimeSpan FastInitial = TimeSpan.FromMilliseconds(10);
    private static readonly TimeSpan FastMax = TimeSpan.FromMilliseconds(50);

    private static KomorebiEventListenerService CreateService(ICommandRunner runner) =>
        new(NullLogger<KomorebiEventListenerService>.Instance, Array.Empty<IEventRule>(), runner)
        {
            InitialReconnectDelay = FastInitial,
            MaxReconnectDelay = FastMax,
        };

    private static async Task WaitForAsync(Func<bool> predicate, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (predicate()) return;
            await Task.Delay(25);
        }
        throw new TimeoutException("Predicate did not become true in time");
    }

    private static string ExtractPipeName(Command cmd)
    {
        // Args look like: "subscribe-pipe komorebi-event-<guid>" or "unsubscribe-pipe komorebi-event-<guid>"
        var parts = cmd.Arguments.Split(' ', 2);
        return parts.Length == 2 ? parts[1] : string.Empty;
    }

    private static bool IsSubscribe(Command cmd) => cmd.Arguments.StartsWith("subscribe-pipe");
    private static bool IsUnsubscribe(Command cmd) => cmd.Arguments.StartsWith("unsubscribe-pipe");

    [Fact]
    public async Task Shutdown_AfterSubscribe_UnsubscribesSamePipe()
    {
        // Precondition: nothing has happened yet
        var runner = new RecordingCommandRunner();
        Assert.Empty(runner.Commands);

        var service = CreateService(runner);
        await service.StartAsync(CancellationToken.None);

        // Wait for the initial subscribe to land
        await WaitForAsync(() => runner.Commands.Any(IsSubscribe), TimeSpan.FromSeconds(5));

        await service.StopAsync(CancellationToken.None);

        var commands = runner.Commands.ToList();
        var subscribe = commands.First(IsSubscribe);
        var unsubscribe = commands.First(IsUnsubscribe);

        Assert.Equal(ExtractPipeName(subscribe), ExtractPipeName(unsubscribe));
        Assert.StartsWith("komorebi-event-", ExtractPipeName(subscribe));
    }

    [Fact]
    public async Task SubscribeFailure_RetriesWithFreshPipeName()
    {
        // First subscribe returns ExitCode 1; everything else succeeds.
        var firstCallDone = false;
        var runner = new ScriptedCommandRunner(cmd =>
        {
            if (!firstCallDone && IsSubscribe(cmd))
            {
                firstCallDone = true;
                return new CommandResult(1, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
            }
            return new CommandResult(0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
        });

        var service = CreateService(runner);
        await service.StartAsync(CancellationToken.None);

        // Wait until we've seen at least two subscribe attempts (proves retry happened).
        await WaitForAsync(
            () => runner.Commands.Count(IsSubscribe) >= 2,
            TimeSpan.FromSeconds(5));

        await service.StopAsync(CancellationToken.None);

        var subscribes = runner.Commands.Where(IsSubscribe).ToList();
        Assert.True(subscribes.Count >= 2, $"Expected >=2 subscribe attempts, got {subscribes.Count}");

        // Each subscribe attempt must use a fresh pipe name (stale GUID would risk collisions).
        var pipeNames = subscribes.Select(ExtractPipeName).ToList();
        Assert.Equal(pipeNames.Count, pipeNames.Distinct().Count());

        // Best-effort cleanup: even the failed first attempt should have been followed by unsubscribe
        // (the subscribe-pipe command was attempted, so komorebi may have it registered).
        var firstPipeName = pipeNames[0];
        Assert.Contains(runner.Commands,
            cmd => IsUnsubscribe(cmd) && ExtractPipeName(cmd) == firstPipeName);
    }

    private sealed class ScriptedCommandRunner : ICommandRunner
    {
        private readonly Func<Command, CommandResult> _script;
        private readonly ConcurrentQueue<Command> _commands = new();

        public ScriptedCommandRunner(Func<Command, CommandResult> script)
        {
            _script = script;
        }

        public IReadOnlyCollection<Command> Commands => _commands.ToArray();

        public Task<CommandResult> RunAsync(Command command, CancellationToken cancellationToken = default)
        {
            _commands.Enqueue(command);
            return Task.FromResult(_script(command));
        }
    }
}
