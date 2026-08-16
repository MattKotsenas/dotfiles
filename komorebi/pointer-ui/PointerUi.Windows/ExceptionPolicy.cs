namespace PointerUi.Windows;

internal static class ExceptionPolicy
{
    public static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException
        or StackOverflowException
        or AccessViolationException;
}
