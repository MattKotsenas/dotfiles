namespace PointerUi.Protocol;

public static class PointerUiPipe
{
    public static string ForSession(int sessionId)
    {
        if (sessionId < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(sessionId));
        }

        return (
            $"pointer-ui-v{PointerUiProtocol.CurrentVersion}"
            + $"-{sessionId}");
    }
}
