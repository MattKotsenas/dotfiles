using CliWrap;
using EventListeners.Models;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Dispatches semantic intents received from kanata (via push-msg) to concrete
/// actions. Intent vocabulary is documented in keyboard/INTENTS.md.
///
/// `wm.*` intents map 1:1 to komorebic commands.
/// `nav.*` intents are context-sensitive: terminal apps receive psmux pane
///   navigation via keyboard input; other apps fall back to komorebi focus.
/// `system.*` intents are misc actions (cheatsheet).
/// </summary>
public sealed class IntentDispatchRule : IEventRule
{
    private readonly ILogger<IntentDispatchRule> _logger;
    private readonly ICommandRunner _runner;
    private readonly IKeyboardSender _keyboard;
    private readonly AppFocusTracker _focus;
    private readonly Dictionary<string, Func<Command>> _commandMap;
    private readonly Dictionary<string, NavBinding> _navMap;

    public string Name => "IntentDispatchRule";

    public IntentDispatchRule(
        ILogger<IntentDispatchRule> logger,
        ICommandRunner runner,
        IKeyboardSender keyboard,
        AppFocusTracker focus)
    {
        _logger = logger;
        _runner = runner;
        _keyboard = keyboard;
        _focus = focus;
        _commandMap = BuildCommandMap();
        _navMap = BuildNavMap();
    }

    public void ProcessEvent(IEvent evt)
    {
        if (evt is not KanataMessageEvent { Message: var intent }) return;

        if (_navMap.TryGetValue(intent, out var nav))
        {
            DispatchNav(intent, nav);
            return;
        }

        if (_commandMap.TryGetValue(intent, out var commandFactory))
        {
            var command = commandFactory();
            _ = RunAsync(command, intent);
            return;
        }

        _logger.LogWarning("Unknown intent: {Intent}", intent);
    }

    private void DispatchNav(string intent, NavBinding nav)
    {
        var exe = _focus.FocusedExe;

        // Terminal: send psmux prefix + direction
        if (string.Equals(exe, "WindowsTerminal.exe", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogDebug("Nav intent {Intent} for terminal: sending psmux pane {Direction}",
                intent, nav.PsmuxDirection);
            _keyboard.SendSequence(nav.PsmuxSequence);
            return;
        }

        // Default: komorebi focus
        _logger.LogDebug("Nav intent {Intent} for {Exe}: komorebi focus {Direction}",
            intent, exe ?? "(unknown)", nav.PsmuxDirection);
        var cmd = Komorebic($"focus {nav.PsmuxDirection}");
        _ = RunAsync(cmd, intent);
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

    private static Dictionary<string, NavBinding> BuildNavMap()
    {
        // psmux prefix is Ctrl+Space, followed by h/j/k/l
        // Each nav intent: [Ctrl+Space, direction-key]
        const byte VK_SPACE = 0x20;
        const byte VK_H = 0x48;
        const byte VK_J = 0x4A;
        const byte VK_K = 0x4B;
        const byte VK_L = 0x4C;

        KeyChord PsmuxPrefix() => new(VK_SPACE, KeyModifiers.Ctrl);

        return new Dictionary<string, NavBinding>(StringComparer.Ordinal)
        {
            ["nav.left"] = new("left", new[] { PsmuxPrefix(), new KeyChord(VK_H) }),
            ["nav.down"] = new("down", new[] { PsmuxPrefix(), new KeyChord(VK_J) }),
            ["nav.up"] = new("up", new[] { PsmuxPrefix(), new KeyChord(VK_K) }),
            ["nav.right"] = new("right", new[] { PsmuxPrefix(), new KeyChord(VK_L) }),
        };
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

    private sealed record NavBinding(string PsmuxDirection, IReadOnlyList<KeyChord> PsmuxSequence);
}
