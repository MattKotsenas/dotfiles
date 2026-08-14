using System.Globalization;
using System.IO;
using System.Runtime.ExceptionServices;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace PointerUi;

public static class WpfSceneRenderer
{
    public static byte[] RenderPng(OverlayScene scene)
    {
        byte[]? result = null;
        ExceptionDispatchInfo? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                result = RenderCore(scene);
            }
            catch (Exception exception)
            {
                error = ExceptionDispatchInfo.Capture(exception);
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        error?.Throw();
        return result
            ?? throw new InvalidOperationException("The renderer returned no image.");
    }

    private static byte[] RenderCore(OverlayScene scene)
    {
        var visual = new DrawingVisual();
        using (var drawing = visual.RenderOpen())
        {
            drawing.PushTransform(
                new ScaleTransform(
                    RenderingMetrics.DefaultDpi / scene.Dpi,
                    RenderingMetrics.DefaultDpi / scene.Dpi));
            foreach (var primitive in scene.Primitives)
            {
                Draw(drawing, primitive, scene.Dpi);
            }
            drawing.Pop();
        }

        var bitmap = new RenderTargetBitmap(
            scene.PixelWidth,
            scene.PixelHeight,
            scene.Dpi,
            scene.Dpi,
            PixelFormats.Pbgra32);
        bitmap.Render(visual);

        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = new MemoryStream();
        encoder.Save(stream);
        return stream.ToArray();
    }

    private static void Draw(
        DrawingContext drawing,
        ScenePrimitive primitive,
        double dpi)
    {
        var rect = new Rect(
            primitive.Bounds.X,
            primitive.Bounds.Y,
            primitive.Bounds.Width,
            primitive.Bounds.Height);
        var fill = Brush(primitive.Fill);
        var stroke = primitive.Stroke is null
            ? null
            : new Pen(Brush(primitive.Stroke), primitive.StrokeThickness);

        switch (primitive.Kind)
        {
            case ScenePrimitiveKind.Rectangle:
                drawing.DrawRectangle(fill, stroke, rect);
                break;
            case ScenePrimitiveKind.Ellipse:
                drawing.DrawEllipse(
                    fill,
                    stroke,
                    new Point(
                        primitive.Bounds.Center.X,
                        primitive.Bounds.Center.Y),
                    primitive.Bounds.Width / 2,
                    primitive.Bounds.Height / 2);
                break;
            case ScenePrimitiveKind.Text:
                DrawText(drawing, primitive, dpi);
                break;
            default:
                throw new ArgumentOutOfRangeException(
                    nameof(primitive),
                    primitive.Kind,
                    "Unknown scene primitive.");
        }
    }

    private static void DrawText(
        DrawingContext drawing,
        ScenePrimitive primitive,
        double dpi)
    {
        var text = new FormattedText(
            primitive.Text ?? string.Empty,
            CultureInfo.InvariantCulture,
            FlowDirection.LeftToRight,
            new Typeface("Cascadia Mono"),
            primitive.FontSize,
            Brush(primitive.TextColor ?? "#FFFFFFFF"),
            dpi / RenderingMetrics.DefaultDpi);
        var origin = new Point(
            primitive.Bounds.Center.X - text.Width / 2,
            primitive.Bounds.Center.Y - text.Height / 2);
        drawing.DrawText(text, origin);
    }

    private static SolidColorBrush Brush(string? color)
    {
        var brush = new SolidColorBrush(
            (Color)ColorConverter.ConvertFromString(
                color ?? "#00000000"));
        brush.Freeze();
        return brush;
    }
}
