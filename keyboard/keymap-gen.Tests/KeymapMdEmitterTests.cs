using KeymapGen;

namespace KeymapGen.Tests;

public sealed class KeymapMdEmitterTests
{
    [Fact]
    public void ProductionKeymap_DocumentsPersistentPointerMode()
    {
        var output = KeymapMdEmitter.Emit(ProductionKeymap.Build());

        Assert.Contains("## pointer", output);
        Assert.Contains("Entered via `CAP spc`", output);
        Assert.Contains("| `CAP spc h` |", output);
        Assert.Contains("| `CAP spc f` |", output);
    }
}
