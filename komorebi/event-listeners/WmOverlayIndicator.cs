using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace EventListeners;

/// <summary>
/// Displays a small "WM" overlay in the corner of the screen when the kanata
/// WM layer is active. Uses raw Win32 window creation (no WPF dependency).
/// The window is always-on-top, click-through, and borderless.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed partial class WmOverlayIndicator : IWmOverlay, IDisposable
{
    private readonly ILogger _logger;
    private nint _hwnd;
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
    }

    public void Hide()
    {
        if (_hwnd == 0) return;
        ShowWindow(_hwnd, SW_HIDE);
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
}
