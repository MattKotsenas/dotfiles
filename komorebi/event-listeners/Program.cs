using System.Runtime.Versioning;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

[assembly: SupportedOSPlatform("windows")]

namespace EventListeners;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        // Register infrastructure
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddSingleton<ICommandRunner, CliWrapCommandRunner>();
        builder.Services.AddSingleton<IWindowAction, WindowAction>();
        builder.Services.AddSingleton<WmOverlayIndicator>();
        builder.Services.AddSingleton<IWmOverlay>(sp => sp.GetRequiredService<WmOverlayIndicator>());

        // KanataEventListenerService is both an IHostedService (reads events) and
        // an IKanataClient (writes requests) -- single long-lived bidirectional TCP connection.
        builder.Services.AddSingleton<KanataEventListenerService>();
        builder.Services.AddSingleton<IKanataClient>(sp => sp.GetRequiredService<KanataEventListenerService>());
        // Lazy<IKanataClient> breaks the construction cycle: KanataEventListenerService
        // wants IEnumerable<IEventRule>, which contains AppLayerRouter, which wants
        // IKanataClient (= KanataEventListenerService). Lazy resolves on first use.
        builder.Services.AddSingleton<Lazy<IKanataClient>>(sp =>
            new Lazy<IKanataClient>(() => sp.GetRequiredService<IKanataClient>()));
        builder.Services.AddHostedService(sp => sp.GetRequiredService<KanataEventListenerService>());

        // Register event rules
        builder.Services.AddSingleton<IEventRule, LayerIndicatorRule>();
        builder.Services.AddSingleton<IEventRule, IntentDispatchRule>();
        builder.Services.AddSingleton<IEventRule, AppLayerRouter>();

        // Komorebi listener is separate (different protocol, different server)
        builder.Services.AddHostedService<KomorebiEventListenerService>();

        // Configure logging to console
        builder.Logging.AddConsole();

        var host = builder.Build();

        await host.RunAsync();

        return Environment.ExitCode;
    }
}

