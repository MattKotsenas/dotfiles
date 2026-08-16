using PointerUi.TestApp;

namespace PointerUi.Acceptance.Tests;

public sealed class ScenarioCommandWatcherTests
{
    [Fact]
    public Task DirectCreate_DeliversCommandOnce() =>
        AssertDeliveryAsync(atomicRename: false);

    [Fact]
    public Task AtomicRename_DeliversCommandOnce() =>
        AssertDeliveryAsync(atomicRename: true);

    private static async Task AssertDeliveryAsync(
        bool atomicRename)
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            $"pointer-ui-command-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var command = Path.Combine(root, "command.txt");
        var temporary = $"{command}.tmp";
        var delivered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var count = 0;

        try
        {
            using var watcher = new ScenarioCommandWatcher(
                command,
                () =>
                {
                    Interlocked.Increment(ref count);
                    delivered.TrySetResult();
                });
            watcher.Start();

            if (atomicRename)
            {
                File.WriteAllText(temporary, "mutate");
                File.Move(temporary, command);
            }
            else
            {
                File.WriteAllText(command, "mutate");
            }
            await delivered.Task.WaitAsync(
                TimeSpan.FromSeconds(5));

            Assert.Equal(1, count);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
