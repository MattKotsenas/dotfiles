using CliWrap;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Dispatches semantic intents received from kanata (via push-msg) to concrete
/// actions. Intent vocabulary is documented in keyboard/INTENTS.md.
///
/// `wm.*` intents map 1:1 to komorebic commands.
/// `system.*` intents are misc actions (cheatsheet).
///
/// Application-specific behavior (e.g. psmux pane nav in Windows Terminal) is
/// no longer dispatched here -- those are kanata macros emitted directly by
/// the appropriate overlay layer.
/// </summary>
public sealed class IntentDispatchRule : IEventRule
{
    private readonly ILogger<IntentDispatchRule> _logger;
    private readonly ICommandRunner _runner;
    private readonly Dictionary<string, Func<Command>> _commandMap;

    public string Name => "IntentDispatchRule";

    public IntentDispatchRule(
        ILogger<IntentDispatchRule> logger,
        ICommandRunner runner)
    {
        _logger = logger;
        _runner = runner;
        _commandMap = BuildCommandMap();
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KanataMessageEvent { Message: var intent }) return;

        if (_commandMap.TryGetValue(intent, out var commandFactory))
        {
            var command = commandFactory();
            _ = RunAsync(command, intent);
            return;
        }

        _logger.LogWarning("Unknown intent: {Intent}", intent);
    }

    private async Task RunAsync(Command command, string intent)
    {
        try
        {
            var result = await _runner.RunAsync(command);
            if (result.ExitCode != 0)
            {
                _logger.LogWarning("Intent {Intent} exited {ExitCode}", intent, result.ExitCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to dispatch intent {Intent}", intent);
        }
    }

    private static Dictionary<string, Func<Command>> BuildCommandMap()
    {
        var map = new Dictionary<string, Func<Command>>(StringComparer.Ordinal);

        // ----- Focus -----
        map["wm.focus.left"] = () => Komorebic("focus left");
        map["wm.focus.down"] = () => Komorebic("focus down");
        map["wm.focus.up"] = () => Komorebic("focus up");
        map["wm.focus.right"] = () => Komorebic("focus right");
        map["wm.focus.cycle-next"] = () => Komorebic("cycle-focus next");
        map["wm.focus.last-workspace"] = () => Komorebic("focus-last-workspace");

        // ----- Move -----
        map["wm.move.left"] = () => Komorebic("move left");
        map["wm.move.down"] = () => Komorebic("move down");
        map["wm.move.up"] = () => Komorebic("move up");
        map["wm.move.right"] = () => Komorebic("move right");
        map["wm.move.promote"] = () => Komorebic("promote");

        // ----- Stack -----
        map["wm.stack.left"] = () => Komorebic("stack left");
        map["wm.stack.down"] = () => Komorebic("stack down");
        map["wm.stack.up"] = () => Komorebic("stack up");
        map["wm.stack.right"] = () => Komorebic("stack right");
        map["wm.stack.unstack"] = () => Komorebic("unstack");
        map["wm.stack.cycle-prev"] = () => Komorebic("cycle-stack previous");
        map["wm.stack.cycle-next"] = () => Komorebic("cycle-stack next");

        // ----- Resize -----
        map["wm.resize.horizontal-decrease"] = () => Komorebic("resize-axis horizontal decrease");
        map["wm.resize.horizontal-increase"] = () => Komorebic("resize-axis horizontal increase");
        map["wm.resize.vertical-decrease"] = () => Komorebic("resize-axis vertical decrease");
        map["wm.resize.vertical-increase"] = () => Komorebic("resize-axis vertical increase");

        // ----- Workspace -----
        for (var i = 0; i < 8; i++)
        {
            var n = i; // capture
            map[$"wm.workspace.focus.{n}"] = () => Komorebic($"focus-workspaces {n}");
            map[$"wm.workspace.move-to.{n}"] = () => Komorebic($"move-to-workspace {n}");
        }

        // ----- Layout / mode -----
        map["wm.layout.flip-horizontal"] = () => Komorebic("flip-layout horizontal");
        map["wm.layout.flip-vertical"] = () => Komorebic("flip-layout vertical");
        map["wm.layout.toggle-float"] = () => Komorebic("toggle-float");
        map["wm.layout.toggle-monocle"] = () => Komorebic("toggle-monocle");
        map["wm.layout.toggle-pause"] = () => Komorebic("toggle-pause");
        map["wm.layout.retile"] = () => Komorebic("retile");

        // ----- System -----
        map["system.cheatsheet"] = OpenCheatsheet;

        return map;
    }

    private static Command Komorebic(string args) =>
        Cli.Wrap("komorebic").WithArguments(args).WithValidation(CommandResultValidation.None);

    private static Command OpenCheatsheet()
    {
        var keymap = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".config", "keyboard", "KEYMAP.md");
        return Cli.Wrap("wt.exe")
            .WithArguments($"-w _quake glow -p \"{keymap}\"")
            .WithValidation(CommandResultValidation.None);
    }
}
