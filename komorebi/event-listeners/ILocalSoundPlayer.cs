namespace EventListeners;

/// <summary>
/// Starts local sound playback without taking focus.
/// </summary>
public interface ILocalSoundPlayer
{
    /// <summary>
    /// Starts <paramref name="sound"/> and returns immediately. A new sound
    /// replaces one already playing.
    /// </summary>
    bool Play(LocalSound sound);
}
