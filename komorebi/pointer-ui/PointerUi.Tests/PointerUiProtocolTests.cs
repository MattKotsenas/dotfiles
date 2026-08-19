using PointerUi.Protocol;

namespace PointerUi.Tests;

public sealed class PointerUiProtocolTests
{
    [Theory]
    [InlineData(PointerUiMode.Hidden)]
    [InlineData(PointerUiMode.Indicator)]
    [InlineData(PointerUiMode.UiHints)]
    [InlineData(PointerUiMode.GridHints)]
    public void Request_RoundTrips(PointerUiMode mode)
    {
        var request = new PointerUiRequest(
            PointerUiProtocol.CurrentVersion,
            42,
            mode);

        var parsed = PointerUiProtocol.ParseRequest(
            PointerUiProtocol.Serialize(request));

        Assert.Equal(request, parsed);
    }

    [Fact]
    public async Task RequestFraming_RoundTrips()
    {
        var request = new PointerUiRequest(
            PointerUiProtocol.CurrentVersion,
            7,
            PointerUiMode.GridHints);
        await using var stream = new MemoryStream();

        await PointerUiProtocol.WriteAsync(
            stream,
            request);
        stream.Position = 0;

        Assert.Equal(
            request,
            await PointerUiProtocol.ReadRequestAsync(
                stream));
    }

    [Fact]
    public async Task Framing_RejectsOversizedLength()
    {
        var bytes = BitConverter.GetBytes(
            PointerUiProtocol.MaxMessageBytes + 1);
        await using var stream = new MemoryStream(bytes);

        var exception = await Assert.ThrowsAsync<
            InvalidDataException>(
            () => PointerUiProtocol.ReadRequestAsync(
                stream));

        Assert.Contains("length", exception.Message);
    }

    [Fact]
    public void ParseRequest_RejectsNumericMode()
    {
        const string json =
            """{"version":1,"sequence":1,"mode":1}""";

        Assert.Throws<System.Text.Json.JsonException>(
            () => PointerUiProtocol.ParseRequest(json));
    }

    [Fact]
    public void ParseRequest_RejectsMissingFields()
    {
        const string json = """{"version":1}""";

        Assert.Throws<System.Text.Json.JsonException>(
            () => PointerUiProtocol.ParseRequest(json));
    }

    [Theory]
    [InlineData(PointerUiInputKind.Key, "A")]
    [InlineData(PointerUiInputKind.Backspace, null)]
    [InlineData(PointerUiInputKind.Cancel, null)]
    public void InputRequest_RoundTrips(
        PointerUiInputKind kind,
        string? key)
    {
        var request = new PointerUiRequest(
            PointerUiProtocol.CurrentVersion,
            9,
            PointerUiMode.UiHints,
            new PointerUiInput(
                kind,
                7,
                key));

        Assert.Equal(
            request,
            PointerUiProtocol.ParseRequest(
                PointerUiProtocol.Serialize(request)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("a")]
    [InlineData("AA")]
    public void KeyInput_RejectsInvalidSymbol(string? key)
    {
        var request = new PointerUiRequest(
            PointerUiProtocol.CurrentVersion,
            1,
            PointerUiMode.UiHints,
            new PointerUiInput(
                PointerUiInputKind.Key,
                7,
                key));

        Assert.Throws<InvalidDataException>(
            () => PointerUiProtocol.Serialize(request));
    }

    [Fact]
    public void Input_RejectsNonUiHintMode()
    {
        var request = new PointerUiRequest(
            PointerUiProtocol.CurrentVersion,
            1,
            PointerUiMode.Hidden,
            new PointerUiInput(
                PointerUiInputKind.Cancel,
                1));

        Assert.Throws<InvalidDataException>(
            () => PointerUiProtocol.Serialize(request));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("S")]
    public void CompletedInput_RequiresMatchingSelection(
        string? selectedLabel)
    {
        var response = new PointerUiResponse(
            PointerUiProtocol.CurrentVersion,
            1,
            PointerUiMode.UiHints,
            true,
            0,
            null,
            false,
            new PointerUiInputResult(
                PointerUiSessionStatus.Completed,
                "A",
                true,
                selectedLabel));

        Assert.Throws<InvalidDataException>(
            () => PointerUiProtocol.Serialize(response));
    }

    [Fact]
    public void InputResult_RejectsContradictoryEnvelope()
    {
        var response = new PointerUiResponse(
            PointerUiProtocol.CurrentVersion,
            1,
            PointerUiMode.Hidden,
            true,
            0,
            "error",
            true,
            new PointerUiInputResult(
                PointerUiSessionStatus.Active,
                string.Empty,
                true,
                null),
            1);

        Assert.Throws<InvalidDataException>(
            () => PointerUiProtocol.Serialize(response));
    }

    [Fact]
    public void PipeName_IsScopedToWindowsSession()
    {
        Assert.Equal(
            "pointer-ui-v1-17",
            PointerUiPipe.ForSession(17));
    }
}
