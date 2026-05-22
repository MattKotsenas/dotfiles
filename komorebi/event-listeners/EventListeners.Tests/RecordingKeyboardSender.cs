using System.Collections.Concurrent;

namespace EventListeners.Tests;

/// <summary>
/// Records all key sequences sent without actually sending input.
/// </summary>
public sealed class RecordingKeyboardSender : IKeyboardSender
{
    private readonly ConcurrentQueue<IReadOnlyList<KeyChord>> _sequences = new();

    public IReadOnlyCollection<IReadOnlyList<KeyChord>> Sequences => _sequences.ToArray();

    public void SendSequence(IReadOnlyList<KeyChord> sequence)
    {
        _sequences.Enqueue(sequence);
    }
}
