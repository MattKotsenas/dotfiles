using System.Runtime.Versioning;
using EventListeners;

namespace EventListeners.Tests;

[SupportedOSPlatform("windows")]
public class Win32KeyboardSenderTests
{
    [Fact]
    public void InputStruct_HasCorrectSizeForWin32Api()
    {
        // SendInput requires cbSize == sizeof(INPUT) exactly.
        // On x64 that's 40 bytes (4 type + 4 padding + 32 union slot).
        // Anything else and SendInput returns 0 with no events sent.
        Assert.Equal(40, Win32KeyboardSender.InputStructSize);
    }
}
