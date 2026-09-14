import { describe, expect, it, vi } from "vitest";
import {
  appendTerminalOutputChunk,
  emptyTerminalOutputStream,
  startTerminalOutputStream,
  TERMINAL_OUTPUT_CHAR_CAP,
} from "./terminalOutputStream";
import { TerminalOutputWriter } from "./terminalOutputWriter";

describe("terminal output consumer", () => {
  it("writes 100 MiB once without replaying the retained tail at every trim", () => {
    let writtenChars = 0;
    const reset = vi.fn();
    const writer = new TerminalOutputWriter({
      reset,
      write: (text, done) => {
        writtenChars += text.length;
        done();
      },
    });
    const chunk = "x".repeat(64 * 1024);
    let stream = startTerminalOutputStream(emptyTerminalOutputStream, "pty-1");
    for (let index = 0; index < 1600; index += 1) {
      stream = appendTerminalOutputChunk(stream, "pty-1", chunk);
      writer.update(stream);
    }
    expect(writtenChars).toBe(100 * 1024 * 1024);
    expect(stream.text.length).toBe(TERMINAL_OUTPUT_CHAR_CAP);
    expect(reset).not.toHaveBeenCalled();
  });

  it("bounds a stalled sink and resynchronizes only after a missed tail", () => {
    let acknowledge: (() => void) | undefined;
    const sink = {
      reset: vi.fn(),
      write: vi.fn((_text: string, done: () => void) => {
        acknowledge = done;
      }),
    };
    const writer = new TerminalOutputWriter(sink);
    let stream = startTerminalOutputStream(emptyTerminalOutputStream, "pty-1");
    stream = appendTerminalOutputChunk(stream, "pty-1", "first");
    writer.update(stream);
    for (let index = 0; index < 100; index += 1) {
      stream = appendTerminalOutputChunk(
        stream,
        "pty-1",
        "x".repeat(64 * 1024),
      );
      writer.update(stream);
    }
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(sink.reset).not.toHaveBeenCalled();
    acknowledge?.();
    expect(sink.write).toHaveBeenCalledTimes(2);
    expect(sink.write.mock.calls[1]?.[0]).toBe(stream.text);
    expect(sink.write.mock.calls[1]?.[0].length).toBe(TERMINAL_OUTPUT_CHAR_CAP);
    expect(sink.reset).toHaveBeenCalledOnce();
    acknowledge?.();
    expect(sink.write).toHaveBeenCalledTimes(2);
  });

  it("replays only the retained tail on remount and ignores an unchanged snapshot", () => {
    const stream = appendTerminalOutputChunk(
      startTerminalOutputStream(emptyTerminalOutputStream, "pty-1"),
      "pty-1",
      "x".repeat(TERMINAL_OUTPUT_CHAR_CAP + 10),
    );
    const sink = {
      reset: vi.fn(),
      write: vi.fn((_text: string, done: () => void) => done()),
    };
    const writer = new TerminalOutputWriter(sink);
    writer.update(stream);
    writer.update(stream);
    expect(sink.write).toHaveBeenCalledOnce();
    expect(sink.write.mock.calls[0]?.[0]).toBe(stream.text);
    expect(sink.reset).not.toHaveBeenCalled();
  });

  it("resets on restart after an in-flight write and stops on disposal", () => {
    let acknowledge: (() => void) | undefined;
    const sink = {
      reset: vi.fn(),
      write: vi.fn((_text: string, done: () => void) => {
        acknowledge = done;
      }),
    };
    const writer = new TerminalOutputWriter(sink);
    const old = appendTerminalOutputChunk(
      startTerminalOutputStream(emptyTerminalOutputStream, "pty-1"),
      "pty-1",
      "old",
    );
    writer.update(old);
    const restarted = startTerminalOutputStream(old, "pty-2");
    writer.update(appendTerminalOutputChunk(restarted, "pty-2", "new"));
    expect(sink.reset).not.toHaveBeenCalled();
    acknowledge?.();
    expect(sink.reset).toHaveBeenCalledOnce();
    expect(sink.write.mock.calls.map(([text]) => text)).toEqual(["old", "new"]);
    writer.update(appendTerminalOutputChunk(restarted, "pty-2", "new pending"));
    writer.dispose();
    acknowledge?.();
    writer.update(old);
    expect(sink.write).toHaveBeenCalledTimes(2);
  });
});
