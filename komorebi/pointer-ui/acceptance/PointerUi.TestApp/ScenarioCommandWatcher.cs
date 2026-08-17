using System.Diagnostics;
using System.IO;

namespace PointerUi.TestApp;

internal sealed class ScenarioCommandWatcher : IDisposable
{
    private static readonly TimeSpan ReadTimeout =
        TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ReadRetryDelay =
        TimeSpan.FromMilliseconds(25);

    private readonly string _commandFile;
    private readonly FileSystemWatcher _watcher;
    private readonly Action<string> _callback;
    private int _handled;

    public ScenarioCommandWatcher(
        string commandFile,
        Action<string> callback)
    {
        var directory = Path.GetDirectoryName(commandFile)
            ?? throw new ArgumentException(
                "Command file has no directory.",
                nameof(commandFile));
        _commandFile = commandFile;
        _callback = callback;
        _watcher = new FileSystemWatcher(
            directory,
            Path.GetFileName(commandFile))
        {
            NotifyFilter = NotifyFilters.FileName,
        };
        _watcher.Created += Handle;
        _watcher.Renamed += Handle;
    }

    public void Start() =>
        _watcher.EnableRaisingEvents = true;

    public void Dispose() =>
        _watcher.Dispose();

    private void Handle(
        object sender,
        FileSystemEventArgs args)
    {
        if (Interlocked.Exchange(ref _handled, 1) == 0)
        {
            _callback(ReadWithRetry(
                () => File.ReadAllText(_commandFile).Trim()));
        }
    }

    internal static string ReadWithRetry(Func<string> read)
    {
        var started = Stopwatch.GetTimestamp();
        while (true)
        {
            try
            {
                return read();
            }
            catch (IOException) when (
                Stopwatch.GetElapsedTime(started) < ReadTimeout)
            {
                Thread.Sleep(ReadRetryDelay);
            }
        }
    }
}
