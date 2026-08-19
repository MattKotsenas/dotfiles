using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace PointerUi.TestApp;

internal static class AcceptanceScenarioCatalog
{
    public static AcceptanceScenario Create(
        string scenario,
        Action saveAction) =>
        scenario switch
        {
            "all-windows" => CreateAllWindows(
                saveAction),
            _ => throw new ArgumentOutOfRangeException(
                nameof(scenario),
                scenario,
                "Unknown acceptance scenario."),
        };

    private static AcceptanceScenario CreateAllWindows(
        Action saveAction)
    {
        var background = Window(
            "acceptance-background",
            "Pointer UI Acceptance - Background",
            660,
            120);
        background.Content = Panel(
            Heading("Background semantic targets"),
            Identified(
                new CheckBox
                {
                    Content = "Mute",
                    IsChecked = false,
                },
                "mute"),
            Identified(
                new TextBox
                {
                    Text = "Background editor",
                    Width = 260,
                },
                "background-editor"));

        var primary = Window(
            "acceptance-primary",
            "Pointer UI Acceptance - Document A",
            100,
            100);
        var duplicates = new StackPanel
        {
            Orientation = Orientation.Horizontal,
        };
        duplicates.Children.Add(Identified(
            new Button { Content = "Duplicate" },
            "duplicate"));
        duplicates.Children.Add(Identified(
            new Button { Content = "Duplicate" },
            "duplicate"));
        var nameless = new Button
        {
            Width = 40,
            Height = 30,
        };
        var tabs = new TabControl();
        tabs.Items.Add(Identified(
            new TabItem
            {
                Header = "General",
                Content = "General content",
            },
            "general-tab"));
        tabs.Items.Add(Identified(
            new TabItem
            {
                Header = "Advanced",
                Content = "Advanced content",
            },
            "advanced-tab"));
        var save = Identified(
            new Button { Content = "Save" },
            "save");
        save.Click += (_, _) => saveAction();
        var primaryPanel = Panel(
            Heading("Foreground targets"),
            save,
            Identified(
                new TextBox
                {
                    Text = "Foreground editor",
                    Width = 300,
                },
                "editor"),
            duplicates,
            nameless,
            tabs);
        primary.Content = primaryPanel;

        return new AcceptanceScenario(
            [background, primary],
            () =>
            {
                primary.Title =
                    "Pointer UI Acceptance - Document B";
                var first = primaryPanel.Children[1];
                primaryPanel.Children.RemoveAt(1);
                primaryPanel.Children.Add(first);
            });
    }

    private static Window Window(
        string automationId,
        string title,
        double left,
        double top)
    {
        var window = new Window
        {
            Title = title,
            Width = 500,
            Height = 520,
            Left = left,
            Top = top,
            WindowStartupLocation = WindowStartupLocation.Manual,
        };
        AutomationProperties.SetAutomationId(
            window,
            automationId);
        return window;
    }

    private static StackPanel Panel(
        params UIElement[] children)
    {
        var panel = new StackPanel
        {
            Margin = new Thickness(24),
        };
        foreach (var child in children)
        {
            panel.Children.Add(child);
        }
        return panel;
    }

    private static TextBlock Heading(string text) =>
        new()
        {
            Text = text,
            FontSize = 22,
            Margin = new Thickness(0, 0, 0, 18),
        };

    private static T Identified<T>(
        T element,
        string automationId)
        where T : UIElement
    {
        AutomationProperties.SetAutomationId(
            element,
            automationId);
        if (element is FrameworkElement frameworkElement)
        {
            frameworkElement.Margin =
                new Thickness(0, 0, 0, 12);
        }
        return element;
    }
}

internal sealed record AcceptanceScenario(
    IReadOnlyList<Window> Windows,
    Action Mutate);
