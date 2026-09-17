// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { MessageActions } from "./MessageActions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("message copy feedback lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let writeText: MockInstance<Clipboard["writeText"]>;
  const status = () => container.querySelector('[role="status"]')!.textContent;
  const render = (text: string) =>
    act(() =>
      root!.render(
        <StrictMode>
          <MessageActions text={text} locale="en" />
        </StrictMode>,
      ),
    );
  const click = () =>
    act(async () => container.querySelector("button")!.click());
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("copies the latest rendered message and resets success and failure feedback", async () => {
    render("old");
    render("latest😀");
    await click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("latest😀");
    expect(status()).toBe("Copied");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(status()).toBe("");
    writeText.mockRejectedValueOnce(new Error("unavailable"));
    await click();
    expect(status()).toBe("Copy failed; copy manually");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(status()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases its timer and ignores a clipboard response after unmount", async () => {
    render("copy");
    await click();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root!.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
    render("pending");
    let resolve!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await click();
    act(() => root!.unmount());
    root = null;
    await act(async () => resolve());
    expect(vi.getTimerCount()).toBe(0);
    expect(container.innerHTML).toBe("");
  });

  it("keeps one timer and the latest feedback when clipboard requests finish out of order", async () => {
    render("copy");
    let resolve!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await click();
    writeText.mockRejectedValueOnce(new Error("latest failed"));
    await click();
    expect(status()).toBe("Copy failed; copy manually");
    await act(async () => resolve());
    expect(status()).toBe("Copy failed; copy manually");
    expect(vi.getTimerCount()).toBe(1);
    await click();
    expect(status()).toBe("Copied");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(status()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
