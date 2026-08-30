/*
 * Terminal output used to live in the shared `capabilityPanel`, so opening any
 * other workbench surface (review, files, a plugin detail) replaced the panel
 * and every later `command/exec/outputDelta` was dropped on the floor. The PTY
 * stayed alive but its tab became a dead screen. Output now owns its own state,
 * keyed by process, so panels and terminals can no longer overwrite each other.
 */

/** Chars retained before the head is dropped; roughly xterm's 5000-line scrollback. */
export const TERMINAL_OUTPUT_CHAR_CAP = 400_000;

export type TerminalOutputStream = {
  /**
   * Bumped whenever `text` stops being a pure append (process restart or cap
   * trim). Consumers reset their view instead of guessing from string prefixes.
   */
  generation: number;
  processId: string | null;
  text: string;
};

export const emptyTerminalOutputStream: TerminalOutputStream = {
  generation: 0,
  processId: null,
  text: "",
};

/**
 * Starts a stream for `processId`, discarding any output from an earlier
 * process so a restarted terminal never shows the previous session's tail.
 */
export function startTerminalOutputStream(
  stream: TerminalOutputStream,
  processId: string,
): TerminalOutputStream {
  if (stream.processId === processId) {
    return stream;
  }
  return { generation: stream.generation + 1, processId, text: "" };
}

/**
 * Appends one output delta. Chunks from a stale process are ignored so a
 * terminated session cannot write into the tab that replaced it.
 */
export function appendTerminalOutputChunk(
  stream: TerminalOutputStream,
  processId: string,
  chunk: string,
): TerminalOutputStream {
  if (stream.processId !== processId || !chunk) {
    return stream;
  }
  const text = `${stream.text}${chunk}`;
  if (text.length <= TERMINAL_OUTPUT_CHAR_CAP) {
    return { ...stream, text };
  }
  return {
    generation: stream.generation + 1,
    processId,
    text: text.slice(text.length - TERMINAL_OUTPUT_CHAR_CAP),
  };
}

/**
 * Writes a trailing line (exit status, error) without claiming a process, so
 * the text survives after the PTY is gone.
 */
export function appendTerminalOutputNotice(
  stream: TerminalOutputStream,
  notice: string,
): TerminalOutputStream {
  if (!notice) {
    return stream;
  }
  const separator = !stream.text || stream.text.endsWith("\n") ? "" : "\r\n";
  return { ...stream, text: `${stream.text}${separator}${notice}` };
}
