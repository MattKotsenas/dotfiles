namespace PointerUi;

public static class DiscoveryProjector
{
    private const int MaxHierarchyHintLength = 120;

    public static DiscoveryProjection Project(
        DesktopCapture capture,
        string fixtureName,
        WindowRoleSession roleSession)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fixtureName);
        if (capture.DesktopBounds.Width <= 0
            || capture.DesktopBounds.Height <= 0)
        {
            throw new ArgumentException(
                "Desktop capture has invalid bounds.",
                nameof(capture));
        }

        var roles = roleSession.Assign(capture.Windows);
        var diagnostics = new List<ProjectionDiagnostic>();
        var windows = capture.Windows
            .Select(window => ProjectWindow(
                capture.DesktopBounds,
                window,
                roles[window.SessionKey],
                diagnostics))
            .Where(window => window is not null)
            .Cast<WindowFixture>()
            .OrderBy(window => window.WindowRole, StringComparer.Ordinal)
            .ToList();

        var duplicateIds = windows
            .SelectMany(window => window.Targets.Select(target => new
            {
                Window = window,
                Target = target,
                Id = LogicalTargetIdentity.Create(window, target),
            }))
            .GroupBy(item => item.Id)
            .Where(group => group.Count() > 1)
            .ToDictionary(
                group => group.Key,
                group => group.ToList());

        if (duplicateIds.Count > 0)
        {
            foreach (var duplicate in duplicateIds
                .OrderBy(item => item.Key.Value, StringComparer.Ordinal))
            {
                var rolesWithCollision = duplicate.Value
                    .Select(item => item.Window.WindowRole)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(role => role, StringComparer.Ordinal);
                diagnostics.Add(new ProjectionDiagnostic(
                    "ambiguous-logical-target",
                    string.Join(", ", rolesWithCollision),
                    $"Excluded {duplicate.Value.Count} targets with logical ID {duplicate.Key}."));
            }

            var ambiguous = duplicateIds.Keys.ToHashSet();
            windows = windows
                .Select(window => window with
                {
                    Targets = window.Targets
                        .Where(target => !ambiguous.Contains(
                            LogicalTargetIdentity.Create(window, target)))
                        .ToList(),
                })
                .ToList();
        }

        return new DiscoveryProjection(
            new DesktopFixture(
                1,
                fixtureName,
                FixtureMode.UiHints,
                capture.DesktopBounds,
                RenderingMetrics.DefaultDpi,
                null,
                windows,
                null),
            diagnostics);
    }

    private static WindowFixture? ProjectWindow(
        PixelRect desktopBounds,
        WindowCapture window,
        string role,
        List<ProjectionDiagnostic> diagnostics)
    {
        var visibleWindow = Intersect(desktopBounds, window.Bounds);
        if (visibleWindow is null || window.Dpi <= 0)
        {
            return null;
        }

        var targets = new List<TargetFixture>();
        Visit(
            window.Root,
            [],
            isRoot: true,
            window.IsForeground,
            desktopBounds,
            targets,
            role,
            diagnostics);
        return new WindowFixture(
            window.ProcessKey,
            role,
            visibleWindow.Value,
            window.Dpi,
            window.IsForeground,
            targets);
    }

    private static void Visit(
        ElementCapture element,
        IReadOnlyList<string> ancestors,
        bool isRoot,
        bool isForeground,
        PixelRect desktopBounds,
        List<TargetFixture> targets,
        string windowRole,
        List<ProjectionDiagnostic> diagnostics)
    {
        var hierarchy = ancestors
            .Append(Segment(element, isRoot))
            .ToList();
        var visibleBounds = Intersect(desktopBounds, element.Bounds);
        if (!isRoot && visibleBounds is { } bounds)
        {
            if (IsCandidate(element, isForeground))
            {
                targets.Add(new TargetFixture(
                    element.AutomationId,
                    element.ControlType,
                    element.Name,
                    hierarchy,
                    bounds,
                    element.SemanticAction));
            }
            else if (IsInteractable(element, isForeground)
                && string.IsNullOrWhiteSpace(element.AutomationId)
                && string.IsNullOrWhiteSpace(element.Name))
            {
                diagnostics.Add(new ProjectionDiagnostic(
                    "target-missing-logical-identity",
                    windowRole,
                    $"Excluded nameless {element.ControlType}."));
            }
        }

        foreach (var child in element.Children)
        {
            Visit(
                child,
                hierarchy,
                isRoot: false,
                isForeground,
                desktopBounds,
                targets,
                windowRole,
                diagnostics);
        }
    }

    private static bool IsCandidate(
        ElementCapture element,
        bool isForeground) =>
        IsInteractable(element, isForeground)
        && (!string.IsNullOrWhiteSpace(element.AutomationId)
            || !string.IsNullOrWhiteSpace(element.Name));

    private static bool IsInteractable(
        ElementCapture element,
        bool isForeground) =>
        element.IsEnabled
        && !element.IsOffscreen
        && element.IsControlElement
        && element.Bounds.Width > 0
        && element.Bounds.Height > 0
        && (element.SemanticAction is not SemanticActionKind.None
            || (isForeground && element.IsKeyboardFocusable));

    private static string Segment(
        ElementCapture element,
        bool isRoot)
    {
        var parts = new List<string> { element.ControlType };
        if (!string.IsNullOrWhiteSpace(element.AutomationId))
        {
            parts.Add(
                $"#{SemanticText.Compact(element.AutomationId, MaxHierarchyHintLength)}");
        }
        if (!string.IsNullOrWhiteSpace(element.Name)
            && (!isRoot
                || (string.IsNullOrWhiteSpace(element.AutomationId)
                    && string.IsNullOrWhiteSpace(element.ClassName))))
        {
            parts.Add(
                $"[{SemanticText.Compact(element.Name, MaxHierarchyHintLength)}]");
        }
        if (!string.IsNullOrWhiteSpace(element.ClassName))
        {
            parts.Add(
                $".{SemanticText.Compact(element.ClassName, MaxHierarchyHintLength)}");
        }
        return string.Concat(parts);
    }

    private static PixelRect? Intersect(PixelRect left, PixelRect right)
    {
        var x = Math.Max(left.X, right.X);
        var y = Math.Max(left.Y, right.Y);
        var rightEdge = Math.Min(
            left.X + left.Width,
            right.X + right.Width);
        var bottomEdge = Math.Min(
            left.Y + left.Height,
            right.Y + right.Height);
        return rightEdge > x && bottomEdge > y
            ? new PixelRect(x, y, rightEdge - x, bottomEdge - y)
            : null;
    }
}
