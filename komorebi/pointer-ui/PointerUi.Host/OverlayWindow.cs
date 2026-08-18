using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace PointerUi.Host;

internal sealed class OverlayWindow : Window
{
    private const int GwlExStyle = -20;
    private const long WsExTransparent = 0x00000020;
    private const long WsExToolWindow = 0x00000080;
    private const long WsExNoActivate = 0x08000000;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private static readonly nint HwndTopmost = new(-1);

    private readonly PixelRect _bounds;
    private readonly SceneElement _scene;

    public PixelRect Bounds => _bounds;

    public OverlayWindow(
        OverlayScene scene,
        PixelRect virtualBounds,
        PixelRect monitorBounds)
    {
        _bounds = monitorBounds;
        AllowsTransparency = true;
        Background = System.Windows.Media.Brushes.Transparent;
        Focusable = false;
        IsHitTestVisible = false;
        ResizeMode = ResizeMode.NoResize;
        ShowActivated = false;
        ShowInTaskbar = false;
        Topmost = true;
        WindowStyle = WindowStyle.None;
        HorizontalContentAlignment =
            HorizontalAlignment.Stretch;
        VerticalContentAlignment =
            VerticalAlignment.Stretch;
        _scene = new SceneElement(
            scene,
            new PixelPoint(
                monitorBounds.X - virtualBounds.X,
                monitorBounds.Y - virtualBounds.Y));
        Content = _scene;
        SourceInitialized += ConfigureWindow;
    }

    public void Update(
        OverlayScene scene,
        PixelRect virtualBounds) =>
        _scene.Update(
            scene,
            new PixelPoint(
                _bounds.X - virtualBounds.X,
                _bounds.Y - virtualBounds.Y));

    private void ConfigureWindow(object? sender, EventArgs args)
    {
        var handle = new WindowInteropHelper(this).Handle;
        var style = GetWindowLongPtr(handle, GwlExStyle).ToInt64();
        _ = SetWindowLongPtr(
            handle,
            GwlExStyle,
            new nint(
                style
                | WsExTransparent
                | WsExToolWindow
                | WsExNoActivate));
        if (!SetWindowPos(
                handle,
                HwndTopmost,
                checked((int)_bounds.X),
                checked((int)_bounds.Y),
                checked((int)_bounds.Width),
                checked((int)_bounds.Height),
                SwpNoActivate | SwpShowWindow))
        {
            throw new InvalidOperationException(
                "Positioning the pointer overlay failed.",
                new System.ComponentModel.Win32Exception(
                    Marshal.GetLastPInvokeError()));
        }
    }

    [DllImport(
        "user32.dll",
        EntryPoint = "GetWindowLongPtrW",
        SetLastError = true)]
    private static extern nint GetWindowLongPtr(
        nint window,
        int index);

    [DllImport(
        "user32.dll",
        EntryPoint = "SetWindowLongPtrW",
        SetLastError = true)]
    private static extern nint SetWindowLongPtr(
        nint window,
        int index,
        nint value);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        nint window,
        nint insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);
}
