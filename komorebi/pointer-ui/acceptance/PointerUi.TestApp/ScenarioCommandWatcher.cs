using System.IO;

namespace PointerUi.TestApp;

internal sealed class ScenarioCommandWatcher : IDisposable
{
    private readonly FileSystemWatcher _watcher;
    private readonly Action _callback;
    private int _handled;

    public ScenarioCommandWatcher(
        string commandFile,
        Action callback)
    {
        var directory = Path.GetDirectoryName(commandFile)
            ?? throw new ArgumentException(
                "Command file has no directory.",
                nameof(commandFile));
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
            _callback();
        }
    }
}
