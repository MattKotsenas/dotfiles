using System.Runtime.CompilerServices;

namespace PointerUi.Tests;

public static class ModuleInitializer
{
    // The comparer treats a zero threshold as failure even when diff is zero.
    private const double ExactPixelThreshold = double.Epsilon;

    [ModuleInitializer]
    public static void Initialize()
    {
        VerifyImageMagick.Initialize();
        VerifyImageMagick.RegisterComparers(
            threshold: ExactPixelThreshold);
    }
}
