using Interop.UIAutomationClient;

namespace PointerUi.Windows;

internal sealed class UiaTreeReader
{
    private readonly IUIAutomation _automation;
    private readonly IUIAutomationTreeWalker _walker;

    public UiaTreeReader()
    {
        _automation = new CUIAutomation();
        _walker = _automation.ControlViewWalker;
    }

    public UiaReadResult ReadWindow(
        nint hwnd,
        CaptureLimits limits)
    {
        var diagnostics = new List<ProjectionDiagnostic>();
        var state = new ReadState(limits.MaxElementsPerWindow);
        var root = _automation.ElementFromHandle(hwnd);
        var capture = ReadElement(
            root,
            depth: 0,
            limits,
            state,
            diagnostics,
            $"0x{hwnd:X}");
        return new UiaReadResult(capture, diagnostics);
    }

    private ElementCapture ReadElement(
        IUIAutomationElement element,
        int depth,
        CaptureLimits limits,
        ReadState state,
        List<ProjectionDiagnostic> diagnostics,
        string window)
    {
        state.Count++;
        var children = new List<ElementCapture>();
        if (depth >= limits.MaxDepth)
        {
            diagnostics.Add(new ProjectionDiagnostic(
                "uia-depth-limit",
                window,
                $"Stopped at depth {limits.MaxDepth}."));
        }
        else if (state.Count >= state.MaxElements)
        {
            diagnostics.Add(new ProjectionDiagnostic(
                "uia-element-limit",
                window,
                $"Stopped after {state.MaxElements} elements."));
        }
        else
        {
            var child = _walker.GetFirstChildElement(element);
            while (child is not null && state.Count < state.MaxElements)
            {
                var current = child;
                child = _walker.GetNextSiblingElement(child);
                try
                {
                    children.Add(ReadElement(
                        current,
                        depth + 1,
                        limits,
                        state,
                        diagnostics,
                        window));
                }
                catch (Exception exception)
                    when (!ExceptionPolicy.IsFatal(exception))
                {
                    diagnostics.Add(new ProjectionDiagnostic(
                        "uia-element-vanished",
                        window,
                        exception.Message));
                }
            }
        }

        var rect = element.CurrentBoundingRectangle;
        return new ElementCapture(
            element.CurrentAutomationId ?? string.Empty,
            ControlTypeName(element.CurrentControlType),
            element.CurrentName ?? string.Empty,
            element.CurrentClassName ?? string.Empty,
            new PixelRect(
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top),
            element.CurrentIsOffscreen != 0,
            element.CurrentIsEnabled != 0,
            element.CurrentIsControlElement != 0,
            element.CurrentIsKeyboardFocusable != 0,
            SemanticAction(element),
            children);
    }

    private static SemanticActionKind SemanticAction(
        IUIAutomationElement element)
    {
        if (IsPatternAvailable(
            element,
            UIA_PropertyIds.UIA_IsTogglePatternAvailablePropertyId))
        {
            return SemanticActionKind.Toggle;
        }
        if (IsPatternAvailable(
            element,
            UIA_PropertyIds.UIA_IsSelectionItemPatternAvailablePropertyId))
        {
            return SemanticActionKind.Select;
        }
        return IsPatternAvailable(
            element,
            UIA_PropertyIds.UIA_IsInvokePatternAvailablePropertyId)
            ? SemanticActionKind.Invoke
            : SemanticActionKind.None;
    }

    private static bool IsPatternAvailable(
        IUIAutomationElement element,
        int propertyId) =>
        element.GetCurrentPropertyValue(propertyId) switch
        {
            bool value => value,
            int value => value != 0,
            _ => false,
        };

    private static string ControlTypeName(int controlType) =>
        controlType switch
        {
            UIA_ControlTypeIds.UIA_ButtonControlTypeId => "Button",
            UIA_ControlTypeIds.UIA_CalendarControlTypeId => "Calendar",
            UIA_ControlTypeIds.UIA_CheckBoxControlTypeId => "CheckBox",
            UIA_ControlTypeIds.UIA_ComboBoxControlTypeId => "ComboBox",
            UIA_ControlTypeIds.UIA_EditControlTypeId => "Edit",
            UIA_ControlTypeIds.UIA_HyperlinkControlTypeId => "Hyperlink",
            UIA_ControlTypeIds.UIA_ImageControlTypeId => "Image",
            UIA_ControlTypeIds.UIA_ListItemControlTypeId => "ListItem",
            UIA_ControlTypeIds.UIA_ListControlTypeId => "List",
            UIA_ControlTypeIds.UIA_MenuControlTypeId => "Menu",
            UIA_ControlTypeIds.UIA_MenuBarControlTypeId => "MenuBar",
            UIA_ControlTypeIds.UIA_MenuItemControlTypeId => "MenuItem",
            UIA_ControlTypeIds.UIA_RadioButtonControlTypeId => "RadioButton",
            UIA_ControlTypeIds.UIA_TabControlTypeId => "Tab",
            UIA_ControlTypeIds.UIA_TabItemControlTypeId => "TabItem",
            UIA_ControlTypeIds.UIA_TextControlTypeId => "Text",
            UIA_ControlTypeIds.UIA_ToolBarControlTypeId => "ToolBar",
            UIA_ControlTypeIds.UIA_TreeControlTypeId => "Tree",
            UIA_ControlTypeIds.UIA_TreeItemControlTypeId => "TreeItem",
            UIA_ControlTypeIds.UIA_CustomControlTypeId => "Custom",
            UIA_ControlTypeIds.UIA_GroupControlTypeId => "Group",
            UIA_ControlTypeIds.UIA_DataGridControlTypeId => "DataGrid",
            UIA_ControlTypeIds.UIA_DataItemControlTypeId => "DataItem",
            UIA_ControlTypeIds.UIA_DocumentControlTypeId => "Document",
            UIA_ControlTypeIds.UIA_SplitButtonControlTypeId => "SplitButton",
            UIA_ControlTypeIds.UIA_WindowControlTypeId => "Window",
            UIA_ControlTypeIds.UIA_PaneControlTypeId => "Pane",
            UIA_ControlTypeIds.UIA_HeaderControlTypeId => "Header",
            UIA_ControlTypeIds.UIA_HeaderItemControlTypeId => "HeaderItem",
            UIA_ControlTypeIds.UIA_TableControlTypeId => "Table",
            UIA_ControlTypeIds.UIA_TitleBarControlTypeId => "TitleBar",
            _ => $"ControlType{controlType}",
        };

    private sealed class ReadState(int maxElements)
    {
        public int MaxElements { get; } = maxElements;
        public int Count { get; set; }
    }
}

internal sealed record UiaReadResult(
    ElementCapture Root,
    IReadOnlyList<ProjectionDiagnostic> Diagnostics);
