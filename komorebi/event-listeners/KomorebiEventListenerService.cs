using System.IO.Pipes;
using System.Text.Json;
using CliWrap;
using EventListeners.Models;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Background service that manages the Komorebi named pipe connection and dispatches events to rules.
/// </summary>
public sealed class KomorebiEventListenerService : BackgroundService
{
    private readonly string _pipeName;
    private readonly ILogger<KomorebiEventListenerService> _logger;
    private readonly IHostApplicationLifetime _appLifetime;
    private readonly IEnumerable<IEventRule> _rules;
    private readonly ICommandRunner _runner;
    private bool _subscribed;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public KomorebiEventListenerService(
        ILogger<KomorebiEventListenerService> logger,
        IHostApplicationLifetime appLifetime,
        IEnumerable<IEventRule> rules,
        ICommandRunner runner)
    {
        _logger = logger;
        _appLifetime = appLifetime;
        _rules = rules;
        _runner = runner;
        _pipeName = $"komorebi-event-{Guid.NewGuid()}";
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Log registered rules at startup
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

        try
        {
            await using var pipeServer = new NamedPipeServerStream(
                _pipeName,
                PipeDirection.In,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);

            _logger.LogInformation("Created named pipe: {PipeName}", _pipeName);

            // Subscribe to Komorebi events
            if (!await SubscribeToPipeAsync())
            {
                Environment.ExitCode = ExitCodes.SubscriptionFailed;
                _appLifetime.StopApplication();
                return;
            }

            _subscribed = true;

            _logger.LogInformation("Waiting for Komorebi to connect...");

            try
            {
                await pipeServer.WaitForConnectionAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                _logger.LogInformation("Shutdown requested while waiting for connection");
                return;
            }

            _logger.LogInformation("Komorebi connected");

            using var reader = new StreamReader(pipeServer);

            while (!stoppingToken.IsCancellationRequested)
            {
                string? line;
                try
                {
                    line = await reader.ReadLineAsync(stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                if (string.IsNullOrEmpty(line))
                {
                    // Check if pipe is still connected
                    if (!pipeServer.IsConnected)
                    {
                        _logger.LogWarning("Pipe disconnected");
                        break;
                    }
                    continue;
                }

                ProcessEvent(line);
            }
        }
        catch (IOException ex)
        {
            _logger.LogError(ex, "Pipe connection error");
            Environment.ExitCode = ExitCodes.PipeConnectionFailed;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in event listener");
            Environment.ExitCode = ExitCodes.UnexpectedError;
        }
        finally
        {
            await CleanupAsync();
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

    private async Task<bool> SubscribeToPipeAsync()
    {
        _logger.LogInformation("Subscribing to Komorebi events with pipe: {PipeName}", _pipeName);

        try
        {
            var result = await _runner.RunAsync(
                Cli.Wrap("komorebic")
                    .WithArguments($"subscribe-pipe {_pipeName}")
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

    private async Task UnsubscribeFromPipeAsync()
    {
        _logger.LogInformation("Unsubscribing from Komorebi events for pipe: {PipeName}", _pipeName);

        try
        {
            var result = await _runner.RunAsync(
                Cli.Wrap("komorebic")
                    .WithArguments($"unsubscribe-pipe {_pipeName}")
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

    private async Task CleanupAsync()
    {
        if (_subscribed)
        {
            await UnsubscribeFromPipeAsync();
            _subscribed = false;
        }
    }
}
