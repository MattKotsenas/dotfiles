namespace KeymapGen;

internal static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
            return 1;
        }

        var keymap = ProductionKeymap.Build();

        switch (args[0])
        {
            case "kanata":
                Console.Write(KanataEmitter.Emit(keymap));
                return 0;

            case "emit-all":
                if (args.Length < 2)
                {
                    Console.Error.WriteLine("emit-all requires a repo root argument");
                    return 1;
                }
                EmitAll(keymap, args[1]);
                return 0;

            default:
                PrintUsage();
                return 1;
        }
    }

    private static void EmitAll(Keymap k, string repoRoot)
    {
        var kbdPath = Path.Combine(repoRoot, "kanata", "kanata.kbd");
        File.WriteAllText(kbdPath, KanataEmitter.Emit(k));
        Console.Out.WriteLine($"wrote {kbdPath}");

        var catalogDir = Path.Combine(repoRoot, "komorebi", "event-listeners", "Generated");
        Directory.CreateDirectory(catalogDir);
        var catalogPath = Path.Combine(catalogDir, "LayerCatalog.g.cs");
        File.WriteAllText(catalogPath, LayerCatalogEmitter.Emit(k));
        Console.Out.WriteLine($"wrote {catalogPath}");

        var keymapPath = Path.Combine(repoRoot, "keyboard", "KEYMAP.md");
        File.WriteAllText(keymapPath, KeymapMdEmitter.Emit(k));
        Console.Out.WriteLine($"wrote {keymapPath}");
    }

    private static void PrintUsage()
    {
        Console.Error.WriteLine("Usage:");
        Console.Error.WriteLine("  keymap-gen kanata                  # emit kanata.kbd to stdout");
        Console.Error.WriteLine("  keymap-gen emit-all <repo-root>    # write all artifacts to their destinations");
    }
}
