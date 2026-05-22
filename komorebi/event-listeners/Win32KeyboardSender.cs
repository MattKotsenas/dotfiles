using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Production <see cref="IKeyboardSender"/> using Win32 SendInput.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class Win32KeyboardSender : IKeyboardSender
{
    private readonly ILogger<Win32KeyboardSender> _logger;
    private const int InterKeyDelayMs = 15;

    public Win32KeyboardSender(ILogger<Win32KeyboardSender> logger)
    {
        _logger = logger;
    }

    public void SendSequence(IReadOnlyList<KeyChord> sequence)
    {
        for (var i = 0; i < sequence.Count; i++)
        {
            var chord = sequence[i];
            SendChord(chord);
            if (i < sequence.Count - 1)
            {
                Thread.Sleep(InterKeyDelayMs);
            }
        }
    }

    private void SendChord(KeyChord chord)
    {
        var mods = chord.Modifiers;
        var inputs = new List<INPUT>();

        if (mods.HasFlag(KeyModifiers.Ctrl))
            inputs.Add(Key(VK_CONTROL, down: true));
        if (mods.HasFlag(KeyModifiers.Shift))
            inputs.Add(Key(VK_SHIFT, down: true));
        if (mods.HasFlag(KeyModifiers.Alt))
            inputs.Add(Key(VK_MENU, down: true));

        inputs.Add(Key(chord.VirtualKey, down: true));
        inputs.Add(Key(chord.VirtualKey, down: false));

        if (mods.HasFlag(KeyModifiers.Alt))
            inputs.Add(Key(VK_MENU, down: false));
        if (mods.HasFlag(KeyModifiers.Shift))
            inputs.Add(Key(VK_SHIFT, down: false));
        if (mods.HasFlag(KeyModifiers.Ctrl))
            inputs.Add(Key(VK_CONTROL, down: false));

        var arr = inputs.ToArray();
        var sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
        if (sent != arr.Length)
        {
            _logger.LogWarning("SendInput sent {Sent}/{Total} events for chord {Chord}",
                sent, arr.Length, chord);
        }
    }

    private static INPUT Key(byte vk, bool down) => new()
    {
        type = INPUT_KEYBOARD,
        ki = new KEYBDINPUT
        {
            wVk = vk,
            dwFlags = down ? 0u : KEYEVENTF_KEYUP
        }
    };

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const byte VK_CONTROL = 0x11;
    private const byte VK_SHIFT = 0x10;
    private const byte VK_MENU = 0x12;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public nint dwExtraInfo;
        private readonly nint _padding1;
        private readonly nint _padding2;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
