using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace EventListeners;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        // Register event rules
        builder.Services.AddSingleton<IKomorebiEventRule, EmptyTeamsWindowRule>();
        // Add additional rules here:
        // builder.Services.AddSingleton<IKomorebiEventRule, AnotherRule>();

        // Register the event listener service
        builder.Services.AddHostedService<KomorebiEventListenerService>();

        // Configure logging to console
        builder.Logging.AddConsole();

        var host = builder.Build();

        await host.RunAsync();

        return Environment.ExitCode;
    }
}

