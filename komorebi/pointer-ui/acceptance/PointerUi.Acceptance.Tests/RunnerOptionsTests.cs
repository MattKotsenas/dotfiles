using PointerUi.Acceptance.Runner;

namespace PointerUi.Acceptance.Tests;

public sealed class RunnerOptionsTests
{
    [Fact]
    public void CompleteOptions_AreParsed()
    {
        var options = RunnerOptions.Parse(
        [
            "--solution", "PointerUi.Acceptance.slnx",
            "--marker", "vm.marker",
            "--artifacts", "artifacts",
            "--result", "result.txt",
            "--error", "error.txt",
            "--timeout-minutes", "30",
        ]);

        Assert.Equal(
            TimeSpan.FromMinutes(30),
            options.BlameTimeout);
        Assert.Equal(
            TimeSpan.FromMinutes(32),
            options.ProcessTimeout);
        Assert.EndsWith(
            "PointerUi.Acceptance.slnx",
            options.Solution,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("121")]
    [InlineData("invalid")]
    public void InvalidTimeout_IsRejected(string timeout)
    {
        var args = new[]
        {
            "--solution", "PointerUi.Acceptance.slnx",
            "--marker", "vm.marker",
            "--artifacts", "artifacts",
            "--result", "result.txt",
            "--error", "error.txt",
            "--timeout-minutes", timeout,
        };

        Assert.Throws<ArgumentException>(
            () => RunnerOptions.Parse(args));
    }
}
