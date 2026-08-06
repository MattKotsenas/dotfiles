using EventListeners.Win32;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Plays bundled WAV files through the Windows multimedia API.
/// </summary>
public sealed class Win32LocalSoundPlayer : ILocalSoundPlayer
{
    private const uint SndAsync = 0x0001;
    private const uint SndNoDefault = 0x0002;
    private const uint SndFileName = 0x00020000;

    private readonly ILogger<Win32LocalSoundPlayer> _logger;
    private readonly string _soundDirectory;
    private readonly Func<string, uint, bool> _playSound;

    private const uint PlaybackFlags = SndAsync | SndNoDefault | SndFileName;

    public Win32LocalSoundPlayer(ILogger<Win32LocalSoundPlayer> logger)
        : this(logger, Path.Combine(AppContext.BaseDirectory, "Sounds"))
    {
    }

    internal Win32LocalSoundPlayer(
        ILogger<Win32LocalSoundPlayer> logger,
        string soundDirectory,
        Func<string, uint, bool>? playSound = null)
    {
        _logger = logger;
        _soundDirectory = soundDirectory;
        _playSound = playSound ?? PlaySound;
    }

    public bool Play(LocalSound sound)
    {
        var path = Path.Combine(_soundDirectory, FileName(sound));
        if (!File.Exists(path))
        {
            _logger.LogWarning("Local sound file does not exist: {Path}", path);
            return false;
        }

        if (_playSound(path, PlaybackFlags))
        {
            return true;
        }

        _logger.LogWarning("Windows could not start local sound playback: {Path}", path);
        return false;
    }

    internal static string FileName(LocalSound sound) => sound switch
    {
        LocalSound.Hiyo => "hiyo.wav",
        LocalSound.Horns => "horns.wav",
        _ => throw new ArgumentOutOfRangeException(nameof(sound), sound, "Unknown local sound"),
    };

    private static bool PlaySound(string path, uint flags) =>
        NativeMethods.PlaySoundW(path, nint.Zero, flags);
}
