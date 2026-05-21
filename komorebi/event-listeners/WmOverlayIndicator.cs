using System.Drawing;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Displays a small "WM" overlay in the corner of the screen when the kanata
/// WM layer is active. Uses raw Win32 window creation (no WPF dependency).
/// The window is always-on-top, click-through, and borderless.
/// </summary>
public sealed class WmOverlayIndicator : IWmOverlay, IDisposable
{
    private readonly ILogger _logger;
    private nint _hwnd;
    private bool _visible;
    private Thread? _messageLoop;
    private readonly ManualResetEventSlim _ready = new();

    private const string ClassName = "WmOverlayClass";
    private const string WindowTitle = "WM";
    private const int Width = 60;
    private const int Height = 28;
    private const int Margin = 8;

    // Catppuccin Mocha Peach for visibility
    private static readonly Color BackgroundColor = Color.FromArgb(250, 179, 135);
    private static readonly Color TextColor = Color.FromArgb(17, 17, 27); // Crust

    public WmOverlayIndicator(ILogger<WmOverlayIndicator> logger)
    {
        _logger = logger;
        StartMessageLoop();
    }

    public void Show()
    {
        if (_hwnd == 0) return;
        _ready.Wait();
        ShowWindow(_hwnd, SW_SHOWNOACTIVATE);
        _visible = true;
    }

    public void Hide()
    {
        if (_hwnd == 0) return;
        ShowWindow(_hwnd, SW_HIDE);
        _visible = false;
    }

    public void Dispose()
    {
        if (_hwnd != 0)
        {
            PostMessage(_hwnd, WM_CLOSE, 0, 0);
        }

        _messageLoop?.Join(1000);
        _ready.Dispose();
    }

    private void StartMessageLoop()
    {
        _messageLoop = new Thread(() =>
        {
            try
            {
                RegisterWindowClass();
                CreateOverlayWindow();
                _ready.Set();

                while (GetMessage(out var msg, 0, 0, 0) > 0)
                {
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "WM overlay window thread failed");
            }
        })
        {
            IsBackground = true,
            Name = "WmOverlayThread"
        };

        _messageLoop.SetApartmentState(ApartmentState.STA);
        _messageLoop.Start();
    }

    private void RegisterWindowClass()
    {
        var wc = new WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(),
            style = CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc = WndProc,
            hInstance = GetModuleHandle(null),
            hCursor = LoadCursor(0, IDC_ARROW),
            hbrBackground = CreateSolidBrush(ColorToCOLORREF(BackgroundColor)),
            lpszClassName = ClassName
        };

        RegisterClassEx(ref wc);
    }

    private void CreateOverlayWindow()
    {
        // Position: top-left corner, below the bar area
        var x = Margin;
        var y = 48 + Margin; // below typical bar height

        _hwnd = CreateWindowEx(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
            ClassName,
            WindowTitle,
            WS_POPUP,
            x, y, Width, Height,
            0, 0, GetModuleHandle(null), 0);

        // Set opacity (slightly transparent)
        SetLayeredWindowAttributes(_hwnd, 0, 220, LWA_ALPHA);
    }

    private static nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam)
    {
        if (msg == WM_PAINT)
        {
            var ps = new PAINTSTRUCT();
            var hdc = BeginPaint(hwnd, ref ps);

            // Fill background
            var bgBrush = CreateSolidBrush(ColorToCOLORREF(BackgroundColor));
            GetClientRect(hwnd, out var rect);
            FillRect(hdc, ref rect, bgBrush);
            DeleteObject(bgBrush);

            // Draw text
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, ColorToCOLORREF(TextColor));

            var font = CreateFont(18, 0, 0, 0, FW_BOLD, 0, 0, 0, 0, 0, 0, 0, 0, "Segoe UI");
            var oldFont = SelectObject(hdc, font);

            DrawText(hdc, "⌨ WM", -1, ref rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

            SelectObject(hdc, oldFont);
            DeleteObject(font);
            EndPaint(hwnd, ref ps);
            return 0;
        }

        if (msg == WM_DESTROY)
        {
            PostQuitMessage(0);
            return 0;
        }

        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    private static uint ColorToCOLORREF(Color c) => (uint)(c.R | (c.G << 8) | (c.B << 16));

    // Win32 constants
    private const uint CS_HREDRAW = 0x0002;
    private const uint CS_VREDRAW = 0x0001;
    private const uint WS_POPUP = 0x80000000;
    private const uint WS_EX_TOPMOST = 0x00000008;
    private const uint WS_EX_TOOLWINDOW = 0x00000080;
    private const uint WS_EX_LAYERED = 0x00080000;
    private const uint WS_EX_TRANSPARENT = 0x00000020;
    private const uint WS_EX_NOACTIVATE = 0x08000000;
    private const uint WM_PAINT = 0x000F;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_DESTROY = 0x0002;
    private const int SW_HIDE = 0;
    private const int SW_SHOWNOACTIVATE = 4;
    private const int SM_CXSCREEN = 0;
    private const int TRANSPARENT = 1;
    private const uint LWA_ALPHA = 0x02;
    private const int FW_BOLD = 700;
    private const uint DT_CENTER = 0x01;
    private const uint DT_VCENTER = 0x04;
    private const uint DT_SINGLELINE = 0x20;
    private static readonly nint IDC_ARROW = 32512;

    // Win32 structs
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public uint cbSize;
        public uint style;
        [MarshalAs(UnmanagedType.FunctionPtr)] public WndProcDelegate lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public nint hInstance;
        public nint hIcon;
        public nint hCursor;
        public nint hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PAINTSTRUCT
    {
        public nint hdc;
        public bool fErase;
        public RECT rcPaint;
        public bool fRestore;
        public bool fIncUpdate;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] rgbReserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public nint hwnd;
        public uint message;
        public nint wParam;
        public nint lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x, y; }

    private delegate nint WndProcDelegate(nint hwnd, uint msg, nint wParam, nint lParam);

    // Win32 imports
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint CreateWindowEx(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint param);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int cmdShow);
    [DllImport("user32.dll")] private static extern bool SetLayeredWindowAttributes(nint hwnd, uint crKey, byte bAlpha, uint dwFlags);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern nint LoadCursor(nint hInstance, nint lpCursorName);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandle(string? lpModuleName);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, nint hwnd, uint filterMin, uint filterMax);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern nint DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern bool PostMessage(nint hwnd, uint msg, nint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
    [DllImport("user32.dll")] private static extern nint DefWindowProc(nint hwnd, uint msg, nint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern nint BeginPaint(nint hwnd, ref PAINTSTRUCT ps);
    [DllImport("user32.dll")] private static extern bool EndPaint(nint hwnd, ref PAINTSTRUCT ps);
    [DllImport("user32.dll")] private static extern bool GetClientRect(nint hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern int FillRect(nint hdc, ref RECT rect, nint hbr);
    [DllImport("gdi32.dll")] private static extern nint CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint obj);
    [DllImport("gdi32.dll")] private static extern int SetBkMode(nint hdc, int mode);
    [DllImport("gdi32.dll")] private static extern uint SetTextColor(nint hdc, uint color);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] private static extern nint CreateFont(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeOut, uint charSet, uint outPrecision, uint clipPrecision, uint quality, uint pitchAndFamily, string face);
    [DllImport("gdi32.dll")] private static extern nint SelectObject(nint hdc, nint obj);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int DrawText(nint hdc, string text, int count, ref RECT rect, uint format);
}
