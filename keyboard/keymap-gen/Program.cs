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
                    Console.Error.WriteLine("emit-all requires an output directory argument");
                    return 1;
                }
                EmitAll(keymap, args[1]);
                return 0;

            default:
                PrintUsage();
                return 1;
        }
    }

    private static void EmitAll(Keymap k, string outDir)
    {
        Directory.CreateDirectory(outDir);
        var kbdPath = Path.Combine(outDir, "kanata.kbd");
        File.WriteAllText(kbdPath, KanataEmitter.Emit(k));
        Console.Out.WriteLine($"wrote {kbdPath}");
    }

    private static void PrintUsage()
    {
        Console.Error.WriteLine("Usage:");
        Console.Error.WriteLine("  keymap-gen kanata                # emit kanata.kbd to stdout");
        Console.Error.WriteLine("  keymap-gen emit-all <out-dir>    # write all artifacts to <out-dir>");
    }
}
