using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests;

public class Win32LocalSoundPlayerTests
{
    [Theory]
    [InlineData(LocalSound.Hiyo, "hiyo.wav")]
    [InlineData(LocalSound.Horns, "horns.wav")]
    public void SoundName_MapsToBundledFile(LocalSound sound, string expected)
    {
        Assert.Equal(expected, Win32LocalSoundPlayer.FileName(sound));
    }

    [Theory]
    [InlineData("hiyo.wav")]
    [InlineData("horns.wav")]
    public void BundledSound_IsCopiedUnchangedBesideTheService(string fileName)
    {
        var output = Path.Combine(AppContext.BaseDirectory, "Sounds", fileName);
        var source = Path.Combine(
            TestPaths.RepoRoot,
            "komorebi",
            "event-listeners",
            "Sounds",
            fileName);

        Assert.True(File.Exists(source), $"Expected source sound at {source}");
        Assert.True(File.Exists(output), $"Expected bundled sound at {output}");
        Assert.Equal(File.ReadAllBytes(source), File.ReadAllBytes(output));
    }

    [Fact]
    public void MissingSound_ReturnsFalse()
    {
        var missingDirectory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var logger = new RecordingLogger<Win32LocalSoundPlayer>();
        var player = new Win32LocalSoundPlayer(
            logger,
            missingDirectory);

        Assert.False(player.Play(LocalSound.Hiyo));
        Assert.Contains(logger.Warnings, warning => warning.Contains("hiyo.wav", StringComparison.Ordinal));
    }

    [Fact]
    public void Playback_UsesAsyncFileNameNoDefaultFlags()
    {
        string? playedPath = null;
        uint playedFlags = 0;
        var player = new Win32LocalSoundPlayer(
            new RecordingLogger<Win32LocalSoundPlayer>(),
            Path.Combine(AppContext.BaseDirectory, "Sounds"),
            (path, flags) =>
            {
                playedPath = path;
                playedFlags = flags;
                return true;
            });

        Assert.True(player.Play(LocalSound.Hiyo));

        Assert.EndsWith(Path.Combine("Sounds", "hiyo.wav"), playedPath, StringComparison.Ordinal);
        // SND_ASYNC | SND_NODEFAULT | SND_FILENAME. SND_NOSTOP is absent, so a
        // later sound interrupts this one instead of being refused.
        Assert.Equal(0x00020003u, playedFlags);
    }

    [Fact]
    public void NativePlaybackFailure_ReturnsFalseAndReportsThePath()
    {
        var logger = new RecordingLogger<Win32LocalSoundPlayer>();
        var calls = 0;
        string? attemptedPath = null;
        var player = new Win32LocalSoundPlayer(
            logger,
            Path.Combine(AppContext.BaseDirectory, "Sounds"),
            (path, _) =>
            {
                calls++;
                attemptedPath = path;
                return false;
            });

        Assert.False(player.Play(LocalSound.Horns));
        Assert.Equal(1, calls);
        Assert.EndsWith(Path.Combine("Sounds", "horns.wav"), attemptedPath, StringComparison.Ordinal);
        Assert.Contains(logger.Warnings, warning => warning.Contains("horns.wav", StringComparison.Ordinal));
    }
}
