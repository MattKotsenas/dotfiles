using System.IO.Pipes;
using System.Text.Json;
using CliWrap;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Background service that manages the Komorebi named pipe connection and dispatches events to rules.
/// Reconnects automatically if the pipe drops (e.g., after komorebi restart or replace-configuration).
/// </summary>
public sealed class KomorebiEventListenerService : ReconnectingBackgroundService
{
    private readonly ILogger<KomorebiEventListenerService> _logger;
    private readonly IEnumerable<IEventRule> _rules;
    private readonly ICommandRunner _runner;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public KomorebiEventListenerService(
        ILogger<KomorebiEventListenerService> logger,
        IEnumerable<IEventRule> rules,
        ICommandRunner runner)
        : base(logger)
    {
        _logger = logger;
        _rules = rules;
        _runner = runner;
    }

    protected override string ConnectionDescription => "Komorebi pipe";

    protected override Task OnStartingAsync(CancellationToken stoppingToken)
    {
        var ruleNames = _rules.Select(r => r.Name).ToList();
        if (ruleNames.Count == 0)
        {
            _logger.LogWarning("No event rules registered. Service will run but take no actions.");
        }
        else
        {
            _logger.LogInformation("Registered {Count} event rule(s): {Rules}",
                ruleNames.Count, string.Join(", ", ruleNames));
        }
        return Task.CompletedTask;
    }

    protected override async Task ConnectAndListenAsync(CancellationToken stoppingToken)
    {
        // Use a fresh pipe name per attempt so a stale subscription on komorebi's side
        // doesn't collide with the new pipe server.
        var pipeName = $"komorebi-event-{Guid.NewGuid()}";

        await using var pipeServer = new NamedPipeServerStream(
            pipeName,
            PipeDirection.In,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);

        _logger.LogInformation("Created named pipe: {PipeName}", pipeName);

        // Track that we attempted the subscribe so we still call unsubscribe on
        // ambiguous CLI failures (e.g., the CliWrap process-priority race where the
        // process exits before we read the result). Best-effort cleanup avoids
        // leaking stale subscriptions on komorebi's side.
        var subscribeAttempted = false;
        try
        {
            subscribeAttempted = true;
            if (!await SubscribeToPipeAsync(pipeName))
            {
                throw new InvalidOperationException($"komorebic subscribe-pipe {pipeName} failed");
            }

            _logger.LogInformation("Waiting for Komorebi to connect...");
            await pipeServer.WaitForConnectionAsync(stoppingToken);
            _logger.LogInformation("Komorebi connected");

            using var reader = new StreamReader(pipeServer);

            while (!stoppingToken.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(stoppingToken);

                if (line is null)
                {
                    _logger.LogWarning("Pipe disconnected (read returned null)");
                    return;
                }

                if (string.IsNullOrEmpty(line))
                {
                    if (!pipeServer.IsConnected)
                    {
                        _logger.LogWarning("Pipe disconnected");
                        return;
                    }
                    continue;
                }

                ProcessEvent(line);
            }
        }
        finally
        {
            if (subscribeAttempted)
            {
                await UnsubscribeFromPipeAsync(pipeName);
            }
        }
    }

    private void ProcessEvent(string json)
    {
        KomorebiEvent? evt;
        try
        {
            evt = JsonSerializer.Deserialize<KomorebiEvent>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse event JSON");
            return;
        }

        if (evt?.Event?.Type is not { } eventType)
        {
            return;
        }

        _logger.LogDebug("Received event: {EventType}", eventType);

        // Wrap as a unified event and fan out to all rules
        var wrappedEvent = new KomorebiWindowEvent(eventType, evt.Event.Content, evt.State);

        foreach (var rule in _rules)
        {
            try
            {
                rule.ProcessEvent(wrappedEvent);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Rule '{RuleName}' threw an exception processing event '{EventType}'",
                    rule.Name, eventType);
            }
        }
    }

    private async Task<bool> SubscribeToPipeAsync(string pipeName)
    {
        _logger.LogInformation("Subscribing to Komorebi events with pipe: {PipeName}", pipeName);

        try
        {
            var result = await _runner.RunAsync(
                Cli.Wrap("komorebic")
                    .WithArguments($"subscribe-pipe {pipeName}")
                    .WithValidation(CommandResultValidation.None));

            if (result.ExitCode != 0)
            {
                _logger.LogError("Failed to subscribe to Komorebi pipe. Exit code: {ExitCode}", result.ExitCode);
                return false;
            }

            _logger.LogInformation("Successfully subscribed to Komorebi events");
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to execute komorebic subscribe-pipe command");
            return false;
        }
    }

    private async Task UnsubscribeFromPipeAsync(string pipeName)
    {
        _logger.LogInformation("Unsubscribing from Komorebi events for pipe: {PipeName}", pipeName);

        try
        {
            var result = await _runner.RunAsync(
                Cli.Wrap("komorebic")
                    .WithArguments($"unsubscribe-pipe {pipeName}")
                    .WithValidation(CommandResultValidation.None));

            if (result.ExitCode != 0)
            {
                _logger.LogWarning("Failed to unsubscribe from Komorebi pipe. Exit code: {ExitCode}", result.ExitCode);
            }
            else
            {
                _logger.LogInformation("Successfully unsubscribed from Komorebi events");
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to execute komorebic unsubscribe-pipe command");
        }
    }
}
