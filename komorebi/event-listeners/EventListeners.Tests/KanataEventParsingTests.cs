namespace EventListeners.Tests;

public class KanataEventParsingTests
{
    [Fact]
    public void LayerChange_ParsesLayerName()
    {
        var evt = KanataEventListenerService.ParseEvent("""{"LayerChange":{"new":"wm-focus"}}""");

        var layer = Assert.IsType<KanataLayerChangeEvent>(evt);
        Assert.Equal("wm-focus", layer.NewLayer);
    }

    [Fact]
    public void LayerChange_Base_ParsesCorrectly()
    {
        var evt = KanataEventListenerService.ParseEvent("""{"LayerChange":{"new":"base"}}""");

        var layer = Assert.IsType<KanataLayerChangeEvent>(evt);
        Assert.Equal("base", layer.NewLayer);
    }

    [Fact]
    public void MessagePush_ParsesMessage()
    {
        var evt = KanataEventListenerService.ParseEvent("""{"MessagePush":{"message":"komorebic focus left"}}""");

        var msg = Assert.IsType<KanataMessageEvent>(evt);
        Assert.Equal("komorebic focus left", msg.Message);
    }

    [Fact]
    public void MessagePush_Cheatsheet_ParsesCorrectly()
    {
        var evt = KanataEventListenerService.ParseEvent("""{"MessagePush":{"message":"cheatsheet"}}""");

        var msg = Assert.IsType<KanataMessageEvent>(evt);
        Assert.Equal("cheatsheet", msg.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("{}")]
    [InlineData("not json at all")]
    [InlineData("""{"UnknownEvent":{"data":"value"}}""")]
    public void UnrecognizedInput_ReturnsNull(string line)
    {
        Assert.Null(KanataEventListenerService.ParseEvent(line));
    }

    [Fact]
    public void MalformedLayerChange_MissingNew_ReturnsNull()
    {
        Assert.Null(KanataEventListenerService.ParseEvent("""{"LayerChange":{"old":"base"}}"""));
    }

    [Fact]
    public void MalformedMessagePush_MissingMessage_ReturnsNull()
    {
        Assert.Null(KanataEventListenerService.ParseEvent("""{"MessagePush":{"data":"value"}}"""));
    }
}
