using System.Buffers.Binary;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PointerUi.Protocol;

public static class PointerUiProtocol
{
    public const int CurrentVersion = 1;
    public const int MaxMessageBytes = 4096;

    public static string Serialize(PointerUiRequest request)
    {
        Validate(
            request.Version,
            request.Sequence,
            request.Mode);
        return JsonSerializer.Serialize(
            request,
            PointerUiJsonContext.Default.PointerUiRequest);
    }

    public static string Serialize(PointerUiResponse response)
    {
        Validate(
            response.Version,
            response.Sequence,
            response.Mode);
        return JsonSerializer.Serialize(
            response,
            PointerUiJsonContext.Default.PointerUiResponse);
    }

    public static PointerUiRequest ParseRequest(string json)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);
        var request = JsonSerializer.Deserialize(
            json,
            PointerUiJsonContext.Default.PointerUiRequest)
            ?? throw new InvalidDataException(
                "Pointer UI request is null.");
        Validate(
            request.Version,
            request.Sequence,
            request.Mode);
        return request;
    }

    public static PointerUiResponse ParseResponse(string json)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);
        var response = JsonSerializer.Deserialize(
            json,
            PointerUiJsonContext.Default.PointerUiResponse)
            ?? throw new InvalidDataException(
                "Pointer UI response is null.");
        Validate(
            response.Version,
            response.Sequence,
            response.Mode);
        return response;
    }

    public static Task WriteAsync(
        Stream stream,
        PointerUiRequest request,
        CancellationToken cancellationToken = default) =>
        WriteFrameAsync(
            stream,
            Serialize(request),
            cancellationToken);

    public static Task WriteAsync(
        Stream stream,
        PointerUiResponse response,
        CancellationToken cancellationToken = default) =>
        WriteFrameAsync(
            stream,
            Serialize(response),
            cancellationToken);

    public static async Task<PointerUiRequest>
        ReadRequestAsync(
            Stream stream,
            CancellationToken cancellationToken = default) =>
        ParseRequest(
            await ReadFrameAsync(
                stream,
                frameTimeout: null,
                cancellationToken: cancellationToken));

    public static async Task<PointerUiRequest>
        ReadRequestAsync(
            Stream stream,
            TimeSpan frameTimeout,
            CancellationToken cancellationToken = default)
    {
        if (frameTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(frameTimeout));
        }
        return ParseRequest(
            await ReadFrameAsync(
                stream,
                frameTimeout,
                cancellationToken));
    }

    public static async Task<PointerUiResponse>
        ReadResponseAsync(
            Stream stream,
            CancellationToken cancellationToken = default) =>
        ParseResponse(
            await ReadFrameAsync(
                stream,
                frameTimeout: null,
                cancellationToken: cancellationToken));

    private static void Validate(
        int version,
        long sequence,
        PointerUiMode mode)
    {
        if (version != CurrentVersion)
        {
            throw new InvalidDataException(
                $"Unsupported pointer UI protocol version {version}.");
        }
        if (sequence < 0)
        {
            throw new InvalidDataException(
                "Pointer UI sequence cannot be negative.");
        }
        if (!Enum.IsDefined(mode))
        {
            throw new InvalidDataException(
                $"Unknown pointer UI mode '{mode}'.");
        }
    }

    private static async Task WriteFrameAsync(
        Stream stream,
        string json,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var payload = Encoding.UTF8.GetBytes(json);
        if (payload.Length > MaxMessageBytes)
        {
            throw new InvalidDataException(
                $"Pointer UI message exceeds {MaxMessageBytes} bytes.");
        }

        var length = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(
            length,
            payload.Length);
        await stream.WriteAsync(length, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    private static async Task<string> ReadFrameAsync(
        Stream stream,
        TimeSpan? frameTimeout,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var lengthBytes = new byte[sizeof(int)];
        var firstByte = await stream.ReadAsync(
            lengthBytes.AsMemory(0, 1),
            cancellationToken);
        if (firstByte == 0)
        {
            throw new EndOfStreamException();
        }

        using var timeout =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
        if (frameTimeout is { } duration)
        {
            timeout.CancelAfter(duration);
        }
        try
        {
            await stream.ReadExactlyAsync(
                lengthBytes.AsMemory(1),
                timeout.Token);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested
                && frameTimeout is not null)
        {
            throw new TimeoutException(
                "Reading the pointer UI frame length "
                + $"exceeded {frameTimeout.Value.TotalSeconds:0} "
                + "seconds.");
        }
        var length = BinaryPrimitives.ReadInt32LittleEndian(
            lengthBytes);
        if (length is <= 0 or > MaxMessageBytes)
        {
            throw new InvalidDataException(
                $"Pointer UI message length {length} is invalid.");
        }

        var payload = new byte[length];
        try
        {
            await stream.ReadExactlyAsync(
                payload,
                timeout.Token);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested
                && frameTimeout is not null)
        {
            throw new TimeoutException(
                "Reading the pointer UI frame payload "
                + $"exceeded {frameTimeout.Value.TotalSeconds:0} "
                + "seconds.");
        }
        return Encoding.UTF8.GetString(payload);
    }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PointerUiRequest))]
[JsonSerializable(typeof(PointerUiResponse))]
internal sealed partial class PointerUiJsonContext
    : JsonSerializerContext;
