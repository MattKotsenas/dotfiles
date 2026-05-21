using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace EventListeners;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        // Register infrastructure
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddSingleton<IWindowAction, WindowAction>();
        builder.Services.AddSingleton<WmOverlayIndicator>();
        builder.Services.AddSingleton<IWmOverlay>(sp => sp.GetRequiredService<WmOverlayIndicator>());

        // Register event rules
        builder.Services.AddSingleton<IEventRule, EmptyTeamsWindowRule>();
        builder.Services.AddSingleton<IEventRule, LayerIndicatorRule>();
        builder.Services.AddSingleton<IEventRule, KomorebicCommandRule>();

        // Register event listener services
        builder.Services.AddHostedService<KomorebiEventListenerService>();
        builder.Services.AddHostedService<KanataEventListenerService>();

        // Configure logging to console
        builder.Logging.AddConsole();

        var host = builder.Build();

        await host.RunAsync();

        return Environment.ExitCode;
    }
}

