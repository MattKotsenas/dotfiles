using System.Windows;
using System.Windows.Media;

namespace PointerUi.Host;

internal sealed class SceneElement(
    OverlayScene scene,
    PixelPoint viewportOrigin)
    : FrameworkElement
{
    private OverlayScene _scene = scene;
    private PixelPoint _viewportOrigin = viewportOrigin;

    public void Update(
        OverlayScene updatedScene,
        PixelPoint updatedViewportOrigin)
    {
        _scene = updatedScene;
        _viewportOrigin = updatedViewportOrigin;
        InvalidateVisual();
    }

    protected override Size MeasureOverride(
        Size availableSize) =>
        new(
            double.IsInfinity(availableSize.Width)
                ? 0
                : availableSize.Width,
            double.IsInfinity(availableSize.Height)
                ? 0
                : availableSize.Height);

    protected override void OnRender(DrawingContext drawingContext)
    {
        base.OnRender(drawingContext);
        drawingContext.PushClip(
            new RectangleGeometry(
                new Rect(RenderSize)));
        var dpi = VisualTreeHelper.GetDpi(this);
        WpfSceneRenderer.Draw(
            drawingContext,
            _scene,
            _viewportOrigin,
            dpi.PixelsPerInchX);
        drawingContext.Pop();
    }
}
