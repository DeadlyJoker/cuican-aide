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

  it("trims the head and bumps the generation once output exceeds the cap", () => {
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
      length: trimmed.text.length,
    }).toEqual({
      endsWith: true,
      generation: 2,
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
      processId: "pty-1",
      text: "building\r\n[exit 1]",
    });
  });

  it("writes a notice without a leading blank line into an empty stream", () => {
    expect(
      appendTerminalOutputNotice(emptyTerminalOutputStream, "[no workspace]"),
    ).toEqual({ generation: 0, processId: null, text: "[no workspace]" });
  });
});
