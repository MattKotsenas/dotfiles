import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const minimumWidth = 12;
const promptPrefix = /^ (?:\x1b\[[0-9;]*m)*[>$](?:\x1b\[[0-9;]*m)* /;
const editorRule = /^ [─↑↓]{3,}$/;

export default function (pi: ExtensionAPI) {
  let restore: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    restore?.();
    restore = undefined;
    if (ctx.mode !== "tui") return;

    const ui = ctx.ui;
    const setWidget = ui.setWidget;
    const setEditor = ui.setEditorComponent;
    let primaryRender: ((width: number) => string[]) | undefined;
    let compatible = false;
    let editorBorder: ((text: string) => string) | undefined;
    const border = (text: string) => editorBorder?.(text) ?? ui.theme.fg("borderMuted", text);

    // Load before Powerline: decorate its components as they are installed, including replacements.
    const widgetSetter: typeof ui.setWidget = (key, content: string[] | Parameters<typeof ui.setWidget>[1], options) => {
      if (key !== "powerline-top") return Reflect.apply(setWidget, ui, [key, content, options]);
      primaryRender = undefined;
      if (typeof content !== "function" || options?.placement !== "aboveEditor") {
        return Reflect.apply(setWidget, ui, [key, content, options]);
      }
      setWidget.call(ui, key, (tui, theme) => {
        const component = content(tui, theme);
        const render = component.render.bind(component);
        primaryRender = render;
        component.render = (width) => compatible && width >= minimumWidth ? [] : render(width);
        return component;
      }, options);
    };

    const editorSetter: typeof ui.setEditorComponent = (factory) => {
      compatible = false;
      if (!factory) return setEditor.call(ui, factory);
      setEditor.call(ui, (tui, theme, keybindings) => {
        const editor = factory(tui, theme, keybindings);
        if (editor.constructor.name !== "BashModeEditor") return editor;
        compatible = true;
        editorBorder = (text) => editor.borderColor?.(text) ?? theme.borderColor(text);
        const render = editor.render.bind(editor);
        editor.render = (width) => {
          if (!compatible || width < minimumWidth) return render(width);
          const lines = render(width);
          const bottom = lines.findLastIndex((line, index) => index > 0 && editorRule.test(stripTerminalSequences(line)));
          const body = lines.slice(1, bottom);
          if (!editorRule.test(stripTerminalSequences(lines[0] ?? "")) || bottom < 2
            || !promptPrefix.test(body[0])
            || body.some((line, index) => (index > 0 && !line.startsWith("   ")) || visibleWidth(line) > width)) {
            compatible = false;
            tui.requestRender();
            return lines;
          }

          // Use the full terminal width, matching the untouched footer's overflow calculation.
          const primary = primaryRender?.(width) ?? [];
          const statusLine = primary[0] ?? "";
          const plainStatus = stripTerminalSequences(statusLine);
          if (primary.length > 1 || (statusLine && (!plainStatus.startsWith(" ") || !plainStatus.endsWith(" ") || visibleWidth(statusLine) > width))) {
            compatible = false;
            tui.requestRender();
            return lines;
          }
          const status = statusLine ? sliceByColumn(statusLine, 1, visibleWidth(statusLine) - 2) : "";
          const gap = status && visibleWidth(status) <= width - 4 ? " " : "";
          const up = stripTerminalSequences(lines[0]).includes("↑");
          const down = stripTerminalSequences(lines[bottom]).includes("↓");
          const top = status ? gap + status + gap : "";
          const result = [border("╭") + top + border("─".repeat(width - 2 - visibleWidth(top)) + "╮")];
          // Open sides preserve native wrapping and avoid terminal-dependent emoji width at a right border.
          for (const [index, line] of body.entries()) {
            result.push(index === 0 ? line.replace(promptPrefix, up ? border("↑") + "  " : "   ") : line);
          }
          result.push(border("╰" + (down ? "↓" : "─") + "─".repeat(width - 3) + "╯"));
          // Completion rows are not editor content and must stay outside the outline.
          return [...result, ...lines.slice(bottom + 1)];
        };
        return editor;
      });
    };

    ui.setWidget = widgetSetter;
    ui.setEditorComponent = editorSetter;
    restore = () => {
      if (ui.setWidget === widgetSetter) ui.setWidget = setWidget;
      if (ui.setEditorComponent === editorSetter) ui.setEditorComponent = setEditor;
    };
  });

  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
  });
}
