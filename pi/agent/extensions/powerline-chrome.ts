import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

const minimumWidth = 12;
const promptPrefix = /^ (?:\x1b\[[0-9;]*m)*[>$](?:\x1b\[[0-9;]*m)* /;
const editorRule = /^ [─↑↓]{3,}$/;
type Border = (text: string) => string;
type FrameContent = { body: string[]; completions: string[]; up: "" | "↑"; down: "─" | "↓" };

function powerlineContent(lines: string[], width: number, border: Border): FrameContent | undefined {
  const bottom = lines.findLastIndex((line, index) => index > 0 && editorRule.test(stripTerminalSequences(line)));
  const body = lines.slice(1, bottom);
  if (!editorRule.test(stripTerminalSequences(lines[0] ?? "")) || bottom < 2
    || !promptPrefix.test(body[0])
    || body.some((line, index) => (index > 0 && !line.startsWith("   ")) || visibleWidth(line) > width)) return;

  const up = stripTerminalSequences(lines[0]).includes("↑");
  // Replace only the prompt: cursor columns, native wrapping and ANSI styling stay intact.
  body[0] = body[0].replace(promptPrefix, up ? border("↑") + "  " : "   ");
  return { body, completions: lines.slice(bottom + 1), up: "", down: stripTerminalSequences(lines[bottom]).includes("↓") ? "↓" : "─" };
}

function nativeContent(lines: string[], top: string | undefined, bottom: string | undefined): FrameContent | undefined {
  const end = lines.findLastIndex((line) => line === bottom);
  if (lines[0] !== top || end < 2) return;
  return {
    body: lines.slice(1, end), completions: lines.slice(end + 1),
    up: stripTerminalSequences(top ?? "").includes("↑") ? "↑" : "",
    down: stripTerminalSequences(bottom ?? "").includes("↓") ? "↓" : "─",
  };
}

function roundedFrame(content: FrameContent, primary: string[], width: number, border: Border): string[] | undefined {
  const statusLine = primary[0] ?? "";
  const plainStatus = stripTerminalSequences(statusLine);
  if (primary.length > 1 || (statusLine && (!plainStatus.startsWith(" ") || !plainStatus.endsWith(" ") || visibleWidth(statusLine) > width))) return;
  const status = statusLine ? sliceByColumn(statusLine, 1, visibleWidth(statusLine) - 2) : "";
  const available = width - 2 - content.up.length;
  const gap = status && visibleWidth(status) <= available - 2 ? " " : "";
  const top = status ? gap + status + gap : "";
  if (visibleWidth(top) > available) return;
  return [
    border("╭" + content.up) + top + border("─".repeat(available - visibleWidth(top)) + "╮"),
    ...content.body,
    border("╰" + content.down + "─".repeat(width - 3) + "╯"),
    ...content.completions,
  ];
}

function frameSource(editor: EditorComponent, border: Border) {
  // TODO(someday): use a supported Powerline editor capability instead of its constructor name.
  if (editor.constructor.name !== "BashModeEditor") return;
  const native = !!Reflect.get(editor, Symbol.for("dotfiles.vim-native-frame"));
  const render = editor.render.bind(editor);
  let top: string | undefined;
  let bottom: string | undefined;
  if (native) {
    // TODO(someday): replace protected-border interception with a public Pi frame/layout hook.
    // These exact rows keep Vim-highlighted content and autocomplete outside the frame logic.
    const hooks = editor as EditorComponent & {
      renderTopBorder(width: number, hidden: number): string;
      renderBottomBorder(width: number, hidden: number): string;
    };
    const topBorder = hooks.renderTopBorder.bind(editor);
    const bottomBorder = hooks.renderBottomBorder.bind(editor);
    hooks.renderTopBorder = (width, hidden) => top = topBorder(width, hidden);
    hooks.renderBottomBorder = (width, hidden) => bottom = bottomBorder(width, hidden);
  }
  return {
    native,
    read(width: number) {
      top = bottom = undefined;
      const lines = render(width);
      return { lines, content: native ? nativeContent(lines, top, bottom) : powerlineContent(lines, width, border) };
    },
  };
}

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
    let live = true;
    let factoryDepth = 0;

    // Load before Powerline: capture its primary widget and suppress it only while framing works.
    const widgetSetter: typeof ui.setWidget = (key, content: string[] | Parameters<typeof ui.setWidget>[1], options) => {
      if (!live || key !== "powerline-top") return Reflect.apply(setWidget, ui, [key, content, options]);
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
      if (!live) return setEditor.call(ui, factory);
      compatible = false;
      if (!factory) return setEditor.call(ui, factory);
      setEditor.call(ui, (tui, theme, keybindings) => {
        let editor;
        factoryDepth++;
        try {
          editor = factory(tui, theme, keybindings);
        } finally {
          factoryDepth--;
        }
        // Frame the final decorated editor after Vim has highlighted its native rows.
        if (factoryDepth > 0) return editor;
        const border: Border = (text) => editor.borderColor?.(text) ?? theme.borderColor(text);
        const source = frameSource(editor, border);
        if (!source) return editor;
        compatible = true;
        editor.render = (width) => {
          const { lines, content } = source.read(width);
          if (width < minimumWidth || (!source.native && !compatible)) return lines;
          // Use the full width, matching Powerline's own overflow calculation.
          const framed = content && roundedFrame(content, primaryRender?.(width) ?? [], width, border);
          if (compatible !== !!framed) {
            compatible = !!framed;
            tui.requestRender();
          }
          return framed ?? lines;
        };
        return editor;
      });
    };

    ui.setWidget = widgetSetter;
    ui.setEditorComponent = editorSetter;
    restore = () => {
      live = false;
      if (ui.setWidget === widgetSetter) ui.setWidget = setWidget;
      if (ui.setEditorComponent === editorSetter) ui.setEditorComponent = setEditor;
    };
  });

  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
  });
}
