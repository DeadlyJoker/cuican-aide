import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Circle, Play, Square, Terminal } from "lucide-react";
import { useEffect, useRef } from "react";

import type { Locale } from "../../lib/i18n";
import type { TerminalOutputStream } from "../../lib/terminal/terminalOutputStream";

export function CommandWorkbenchTerminal({
  active,
  cwd,
  disabled,
  locale,
  output,
  processId,
  onResize,
  onStart,
  onStop,
  onWrite,
}: {
  active: boolean;
  cwd: string | null;
  disabled: boolean;
  locale: Locale;
  output: TerminalOutputStream;
  processId: string | null;
  onResize: (cols: number, rows: number) => void;
  onStart: () => void;
  onStop: () => void;
  onWrite: (input: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const writtenGenerationRef = useRef(output.generation);
  const lastSizeRef = useRef("");
  const startedRef = useRef(false);
  const onResizeRef = useRef(onResize);
  const onWriteRef = useRef(onWrite);
  onResizeRef.current = onResize;
  onWriteRef.current = onWrite;

  function reportTerminalSize(cols: number, rows: number) {
    const size = `${cols}x${rows}`;
    if (lastSizeRef.current === size) {
      return;
    }
    lastSizeRef.current = size;
    onResizeRef.current(cols, rows);
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 5000,
      theme: {
        background: "#111111",
        cursor: "#e5e5e5",
        foreground: "#e5e5e5",
        selectionBackground: "#4a638055",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    // A fresh xterm holds none of the stream, so the replay effect starts over.
    writtenLengthRef.current = 0;
    const inputSubscription = terminal.onData((data) =>
      onWriteRef.current(data),
    );
    const resizeObserver = new ResizeObserver(() => {
      if (host.offsetWidth < 1 || host.offsetHeight < 1) {
        return;
      }
      fitAddon.fit();
      reportTerminalSize(terminal.cols, terminal.rows);
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active || !fitAddonRef.current || !terminalRef.current) {
      return;
    }
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal) {
        reportTerminalSize(terminal.cols, terminal.rows);
        terminal.focus();
      }
    });
  }, [active]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!processId || !terminal) {
      return;
    }
    lastSizeRef.current = "";
    reportTerminalSize(terminal.cols, terminal.rows);
  }, [processId]);

  useEffect(() => {
    if (disabled || processId || startedRef.current) {
      return;
    }
    startedRef.current = true;
    onStart();
  }, [disabled, onStart, processId]);

  /*
   * The stream is the source of truth, so a remounted xterm replays the buffer
   * it missed instead of showing a blank screen. A generation bump means the
   * text is no longer an append (restart or scrollback trim), so reset first.
   */
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (output.generation !== writtenGenerationRef.current) {
      terminal.reset();
      writtenGenerationRef.current = output.generation;
      writtenLengthRef.current = 0;
    }
    if (output.text.length <= writtenLengthRef.current) {
      return;
    }
    terminal.write(output.text.slice(writtenLengthRef.current));
    writtenLengthRef.current = output.text.length;
  }, [output.generation, output.text]);

  const running = Boolean(processId);
  return (
    <div className="command-terminal-workbench">
      <header className="command-terminal-header">
        <span>
          <Terminal aria-hidden="true" />
          <strong>{locale === "zh" ? "终端" : "Terminal"}</strong>
        </span>
        <span className="command-terminal-cwd" title={cwd ?? undefined}>
          {cwd ?? (locale === "zh" ? "当前工作空间" : "Current workspace")}
        </span>
        <span
          className="command-terminal-status"
          data-running={running ? "true" : undefined}
        >
          <Circle aria-hidden="true" />
          {running
            ? locale === "zh"
              ? "已连接"
              : "Connected"
            : locale === "zh"
              ? "已结束"
              : "Exited"}
        </span>
        <button
          aria-label={
            running
              ? locale === "zh"
                ? "停止终端"
                : "Stop terminal"
              : locale === "zh"
                ? "重新启动终端"
                : "Restart terminal"
          }
          disabled={disabled}
          type="button"
          onClick={() => {
            if (running) {
              onStop();
            } else {
              /*
               * Starting bumps the stream generation, which resets the view.
               * Clearing here too would only add a flicker.
               */
              startedRef.current = true;
              onStart();
            }
          }}
        >
          {running ? (
            <Square aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
        </button>
      </header>
      <div
        aria-label={locale === "zh" ? "终端会话" : "Terminal session"}
        className="command-terminal-xterm"
        ref={hostRef}
      />
    </div>
  );
}
