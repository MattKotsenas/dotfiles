namespace PointerUi.Acceptance.Tests;

internal static class FileWaiter
{
    public static async Task WaitForFileAsync(
        string path,
        TimeSpan timeout)
    {
        if (File.Exists(path))
        {
            return;
        }

        var directory = Path.GetDirectoryName(path)
            ?? throw new ArgumentException(
                "Ready file has no directory.",
                nameof(path));
        var name = Path.GetFileName(path);
        using var watcher = new FileSystemWatcher(directory, name)
        {
            NotifyFilter = NotifyFilters.FileName,
            EnableRaisingEvents = true,
        };
        var ready = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        watcher.Created += (_, _) => ready.TrySetResult();
        if (File.Exists(path))
        {
            return;
        }

        await ready.Task.WaitAsync(timeout);
    }
}
