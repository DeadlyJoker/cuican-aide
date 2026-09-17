import { describe, expect, it } from "vitest";

import {
  appendTerminalOutputChunk,
  appendTerminalOutputNotice,
  emptyTerminalOutputStream,
  startTerminalOutputStream,
  TERMINAL_OUTPUT_CHAR_CAP,
} from "./terminalOutputStream";

describe("terminal output stream", () => {
  it("accumulates output for the running process across appends", () => {
    const started = startTerminalOutputStream(
      emptyTerminalOutputStream,
      "pty-1",
    );

    expect(
      appendTerminalOutputChunk(
        appendTerminalOutputChunk(started, "pty-1", "pwd\r\n"),
        "pty-1",
        "/repo\r\n",
      ),
    ).toEqual({
      generation: 1,
      startOffset: 0,
      processId: "pty-1",
      text: "pwd\r\n/repo\r\n",
    });
  });

  it("drops output from a process that is no longer the live session", () => {
    const started = startTerminalOutputStream(
      emptyTerminalOutputStream,
      "pty-2",
    );

    expect(appendTerminalOutputChunk(started, "pty-1", "stale")).toBe(started);
  });

  it("resets the buffer and bumps the generation when a new process starts", () => {
    const first = appendTerminalOutputChunk(
      startTerminalOutputStream(emptyTerminalOutputStream, "pty-1"),
      "pty-1",
      "old output",
    );

    expect(startTerminalOutputStream(first, "pty-2")).toEqual({
      generation: 2,
      startOffset: 0,
      processId: "pty-2",
      text: "",
    });
  });

  it("keeps the same stream when the running process starts again", () => {
    const started = startTerminalOutputStream(
      emptyTerminalOutputStream,
      "pty-1",
    );

    expect(startTerminalOutputStream(started, "pty-1")).toBe(started);
  });

  it("trims the head by offset without resetting the live generation", () => {
    const started = startTerminalOutputStream(
      emptyTerminalOutputStream,
      "pty-1",
    );
    const trimmed = appendTerminalOutputChunk(
      appendTerminalOutputChunk(
        started,
        "pty-1",
        "a".repeat(TERMINAL_OUTPUT_CHAR_CAP),
      ),
      "pty-1",
      "bbb",
    );

    expect({
      endsWith: trimmed.text.endsWith("bbb"),
      generation: trimmed.generation,
      startOffset: trimmed.startOffset,
      length: trimmed.text.length,
    }).toEqual({
      endsWith: true,
      generation: 1,
      startOffset: 3,
      length: TERMINAL_OUTPUT_CHAR_CAP,
    });
  });

  it("appends status notices on their own line after live output", () => {
    const running = appendTerminalOutputChunk(
      startTerminalOutputStream(emptyTerminalOutputStream, "pty-1"),
      "pty-1",
      "building",
    );

    expect(appendTerminalOutputNotice(running, "[exit 1]")).toEqual({
      generation: 1,
      startOffset: 0,
      processId: "pty-1",
      text: "building\r\n[exit 1]",
    });
  });

  it("writes a notice without a leading blank line into an empty stream", () => {
    expect(
      appendTerminalOutputNotice(emptyTerminalOutputStream, "[no workspace]"),
    ).toEqual({
      generation: 0,
      startOffset: 0,
      processId: null,
      text: "[no workspace]",
    });
  });

  it("applies the same retention bound to oversized chunks and status notices", () => {
    const chunk = "x".repeat(TERMINAL_OUTPUT_CHAR_CAP + 100);
    const stream = appendTerminalOutputChunk(
      startTerminalOutputStream(emptyTerminalOutputStream, "pty-1"),
      "pty-1",
      chunk,
    );
    const withNotice = appendTerminalOutputNotice(stream, "[exit 1]");
    expect(withNotice.text.length).toBe(TERMINAL_OUTPUT_CHAR_CAP);
    expect(withNotice.startOffset).toBe(110);
    expect(withNotice.text.endsWith("\r\n[exit 1]")).toBe(true);
    expect(withNotice.generation).toBe(stream.generation);
  });
});
