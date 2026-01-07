namespace EventListeners;

/// <summary>
/// Exit codes for the application.
/// </summary>
public static class ExitCodes
{
    public const int Success = 0;
    public const int SubscriptionFailed = 1;
    public const int UnsubscriptionFailed = 2;
    public const int PipeConnectionFailed = 3;
    public const int UnexpectedError = 99;
}
