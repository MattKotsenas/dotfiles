using KeymapGen;

namespace KeymapGen.Tests;

public class ValidatorTests
{
    [Fact]
    public void Overlay_ClaimingReservedGlobalKey_Fails()
    {
        var ex = Assert.Throws<InvalidKeymapException>(() =>
            new KeymapBuilder()
                .Reserve(global: ["r"], subModeEntries: ["f"])
                .WmBase(b => b.Intent("r", "wm.layout.retile"))
                .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
                .Overlay("bad", b => b.Intent("r", "wm.something"))
                .Build());

        Assert.Contains("Overlay 'bad' binds reserved key 'r'", ex.Message);
    }

    [Fact]
    public void Overlay_ClaimingSubModeEntry_Fails()
    {
        var ex = Assert.Throws<InvalidKeymapException>(() =>
            new KeymapBuilder()
                .Reserve(global: [], subModeEntries: ["f"])
                .WmBase(b => { })
                .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
                .Overlay("bad", b => b.Intent("f", "should-fail"))
                .Build());

        Assert.Contains("Overlay 'bad' binds reserved key 'f'", ex.Message);
    }

    [Fact]
    public void DoubleBoundKey_InWmBase_Fails()
    {
        var ex = Assert.Throws<InvalidKeymapException>(() =>
            new KeymapBuilder()
                .Reserve(global: ["r"], subModeEntries: [])
                .WmBase(b => b
                    .Intent("r", "wm.layout.retile")
                    .Intent("r", "wm.layout.toggle-pause"))
                .Build());

        Assert.Contains("binds key 'r' more than once", ex.Message);
    }

    [Fact]
    public void OrphanedSubModeEntryReservation_Fails()
    {
        var ex = Assert.Throws<InvalidKeymapException>(() =>
            new KeymapBuilder()
                .Reserve(global: [], subModeEntries: ["f", "d"])
                .WmBase(b => { })
                .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
                // no SubMode with EntryKey = "d"
                .Build());

        Assert.Contains("Reserved sub-mode entry 'd' has no SubMode definition", ex.Message);
    }

    [Fact]
    public void SubMode_WithUnreservedEntryKey_Fails()
    {
        var ex = Assert.Throws<InvalidKeymapException>(() =>
            new KeymapBuilder()
                .Reserve(global: [], subModeEntries: ["f"])
                .WmBase(b => { })
                .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
                .SubMode("zoom", "z", b => b.Intent("h", "wm.zoom.in"))  // 'z' not reserved
                .Build());

        Assert.Contains("SubMode 'zoom' uses entry key 'z' which is not in Reserved.SubModeEntries", ex.Message);
    }

    [Fact]
    public void DuplicateLayerName_Fails()
    {
        var ex = Assert.Throws<InvalidKeymapException>(() =>
            new KeymapBuilder()
                .Reserve(global: [], subModeEntries: ["f"])
                .WmBase(b => { })
                .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
                .Overlay("focus", b => b.Intent("z", "duplicate"))
                .Build());

        Assert.Contains("Layer name 'focus' is used by multiple SubModes/Overlays", ex.Message);
    }

    [Fact]
    public void Workspaces_WithoutPlaceholder_Fails()
    {
        Assert.Throws<ArgumentException>(() =>
            new KeymapBuilder()
                .Reserve(global: [], subModeEntries: [])
                .WmBase(b => b.Workspaces("wm.workspace.focus.X", 0, 7))
                .Build());
    }

    [Fact]
    public void ValidProductionKeymap_Builds()
    {
        // Should not throw
        var keymap = ProductionKeymap.Build();
        Assert.NotNull(keymap);
        Assert.Equal(6, keymap.SubModes.Count);  // workspace, focus, move, stack, resize, assemble
        Assert.Equal(4, keymap.Overlays.Count);  // terminal, edge, teams, codeflow
    }
}
