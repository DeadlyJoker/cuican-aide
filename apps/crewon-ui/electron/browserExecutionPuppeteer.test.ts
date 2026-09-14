import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import type { BrowserActInput } from "@crewon/contracts";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserViewAutomation } from "./browserExecutionPuppeteer.ts";

const puppeteer = vi.hoisted(() => ({ connect: vi.fn(), connectTab: vi.fn() }));
vi.mock("puppeteer-core", () => ({
  connect: puppeteer.connect,
  ExtensionTransport: { connectTab: puppeteer.connectTab },
  LocatorEvent: { Action: "action" },
}));

const drivers: BrowserViewAutomation[] = [];
const windows: Window[] = [];
let nextId = 1;
const inspectionBundle = `const CrewonBrowserInspection = { inspect: (element) => ({targetId:"",role:element.getAttribute("role")||"textbox",name:element.getAttribute("aria-label")||"Field",tag:element.localName}) };`;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.close()));
  for (const window of windows.splice(0)) await window.happyDOM.close();
  vi.unstubAllGlobals();
});

describe("BrowserViewAutomation native controls and lifecycle", () => {
  it.each([
    '<input readonly value="original">',
    "<textarea readonly>original</textarea>",
    "<input disabled>",
    "<fieldset disabled><input></fieldset>",
    '<input type="checkbox">',
    '<input type="radio">',
    '<input type="button">',
    '<input type="file">',
    '<input type="password">',
    '<input type="hidden">',
  ])(
    "rejects unsupported or non-editable fill without an effect: %s",
    async (html) => {
      const fixture = setup(html);
      await fixture.driver.observe();
      await expect(
        fixture.driver.act(
          input("fill", "updated"),
          "t1",
          new AbortController().signal,
          fixture.beforeEffect,
        ),
      ).rejects.toThrow("browser_fill_unsupported");
      expect(fixture.beforeEffect).not.toHaveBeenCalled();
      expect(fixture.locator.fill).not.toHaveBeenCalled();
      expect(fixture.debugger.sendCommand).toHaveBeenLastCalledWith(
        "Emulation.setFocusEmulationEnabled",
        { enabled: false },
      );
    },
  );

  it.each(['<input type="text">', "<textarea></textarea>"])(
    "permits normal editable native text fields: %s",
    async (html) => {
      const fixture = setup(html);
      await fixture.driver.observe();
      await fixture.driver.act(
        input("fill", "updated"),
        "t1",
        new AbortController().signal,
        fixture.beforeEffect,
      );
      expect(fixture.beforeEffect).toHaveBeenCalledTimes(1);
      expect(fixture.locator.fill).toHaveBeenCalledTimes(1);
      expect(fixture.debugger.sendCommand).toHaveBeenLastCalledWith(
        "Emulation.setFocusEmulationEnabled",
        { enabled: false },
      );
    },
  );

  it.each([
    '<select><option value="existing">Existing</option></select>',
    '<select><option value="missing" disabled>Unavailable</option></select>',
    '<select><optgroup disabled><option value="missing">Unavailable</option></optgroup></select>',
    '<select><option value="missing">A</option><option value="missing">B</option></select>',
  ])(
    "refuses a missing, disabled or ambiguous select value without firing change: %s",
    async (html) => {
      const fixture = setup(html);
      await fixture.driver.observe();
      await expect(
        fixture.driver.act(
          input("select", "missing"),
          "t1",
          new AbortController().signal,
          fixture.beforeEffect,
        ),
      ).rejects.toThrow("browser_select_option_unavailable");
      expect(fixture.beforeEffect).not.toHaveBeenCalled();
      expect(fixture.locator.fill).not.toHaveBeenCalled();
    },
  );

  it("permits an existing enabled native select option", async () => {
    const fixture = setup(
      '<select><option value="direct">Direct</option><option value="partner">Partner</option></select>',
    );
    await fixture.driver.observe();
    await fixture.driver.act(
      input("select", "partner"),
      "t1",
      new AbortController().signal,
      fixture.beforeEffect,
    );
    expect(fixture.beforeEffect).toHaveBeenCalledTimes(1);
    expect(fixture.locator.fill).toHaveBeenCalledWith(
      "partner",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects a changed live name even when the action uses only the original stable ID", async () => {
    const fixture = setup('<button aria-label="Export">Export</button>');
    await fixture.driver.observe();
    fixture.element.setAttribute("aria-label", "Delete");
    await expect(
      fixture.driver.act(
        input("click"),
        "t1",
        new AbortController().signal,
        fixture.beforeEffect,
      ),
    ).rejects.toThrow("browser_target_changed");
    expect(fixture.beforeEffect).not.toHaveBeenCalled();
  });

  it("keeps repeated close calls pending until cleanup has released the debugger registration", async () => {
    const fixture = setup("<input>");
    await fixture.driver.observe();
    const disconnected = deferred<void>();
    fixture.browser.disconnect.mockReturnValueOnce(disconnected.promise);
    const first = fixture.driver.close();
    expect(fixture.driver.close()).toBe(first);
    await tick();
    expect(
      () => new BrowserViewAutomation(fixture.wc, inspectionBundle, vi.fn()),
    ).toThrow("browser_debugger_busy");
    disconnected.resolve(undefined);
    await first;
    const reopened = new BrowserViewAutomation(
      fixture.wc,
      inspectionBundle,
      vi.fn(),
    );
    drivers.push(reopened);
    await expect(reopened.observe()).resolves.toHaveProperty("targets");
    expect(fixture.debugger.detach).toHaveBeenCalled();
  });

  it("closes detached drivers and permits a new driver for the same view after cleanup", async () => {
    const fixture = setup("<input>");
    await fixture.driver.observe();
    fixture.debugger.detach();
    await fixture.driver.close();
    expect(fixture.invalidated).toHaveBeenCalledExactlyOnceWith(
      "debugger-detached",
    );
    await expect(fixture.driver.observe()).rejects.toThrow(
      "browser_driver_closed",
    );
    const reopened = new BrowserViewAutomation(
      fixture.wc,
      inspectionBundle,
      vi.fn(),
    );
    drivers.push(reopened);
    await expect(reopened.observe()).resolves.toHaveProperty("targets");
  });

  it("releases connection-failure registrations and still disconnects when focus cleanup fails", async () => {
    const fixture = setup("<input>", true);
    await expect(fixture.driver.observe()).rejects.toThrow("connection_failed");
    await fixture.driver.close();
    expect(fixture.invalidated).toHaveBeenCalledWith(
      "browser-connection-failed",
    );
    const reopened = new BrowserViewAutomation(
      fixture.wc,
      inspectionBundle,
      vi.fn(),
    );
    drivers.push(reopened);
    await reopened.observe();
    fixture.debugger.sendCommand.mockRejectedValueOnce(
      new Error("debugger_unavailable"),
    );
    await expect(reopened.close()).resolves.toBeUndefined();
    expect(fixture.browser.disconnect).toHaveBeenCalled();
    expect(fixture.debugger.isAttached()).toBe(false);
  });
});

function setup(html: string, connectionFails = false) {
  const window = new Window();
  windows.push(window);
  for (const name of [
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
  ] as const)
    vi.stubGlobal(name, window[name]);
  window.document.body.innerHTML = html;
  const element = window.document.querySelector(
    "input,textarea,select,button",
  )!;
  // happy-dom omits fieldset inheritance for :disabled; Chromium supplies it.
  // Keep that native selector result explicit in this isolated driver test.
  if (element.closest("fieldset[disabled]")) {
    const matches = element.matches.bind(element);
    vi.spyOn(element, "matches").mockImplementation(
      (selector) => selector === ":disabled" || matches(selector),
    );
  }
  let action: () => void = () => undefined;
  const locator = {
    setTimeout: vi.fn().mockImplementation(() => locator),
    on: vi.fn().mockImplementation((_event: string, listener: () => void) => {
      action = listener;
      return locator;
    }),
    fill: vi.fn(async () => {
      action();
    }),
    click: vi.fn(async () => {
      action();
    }),
  };
  const elementHandle = {
    evaluate: vi.fn(
      async (
        evaluate: (element: Element, argument: unknown) => unknown,
        argument: unknown,
      ) => evaluate(element as unknown as Element, argument),
    ),
    asLocator: () => locator,
    dispose: vi.fn(async () => undefined),
    asElement: () => elementHandle,
  };
  const page = {
    evaluate: vi.fn(async () => "visible"),
    evaluateHandle: vi.fn(async () => ({
      getProperty: async (key: string) =>
        key === "observation"
          ? {
              jsonValue: async () => ({
                url: "https://reports.example.com/",
                targets: [
                  {
                    targetId: "t1",
                    role: element.getAttribute("role") || "textbox",
                    name: element.getAttribute("aria-label") || "Field",
                    tag: element.localName,
                  },
                ],
                truncated: false,
                unsupported: [],
              }),
              dispose: async (): Promise<void> => undefined,
            }
          : {
              getProperties: async () => new Map([["0", elementHandle]]),
              dispose: async (): Promise<void> => undefined,
            },
      dispose: async () => undefined,
    })),
  };
  let attached = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
      debuggerApi.emit("detach");
    }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async (_name: string, _params: unknown) => undefined),
  });
  const wc = Object.assign(new EventEmitter(), {
    id: nextId++,
    debugger: debuggerApi,
  }) as unknown as WebContents;
  const browser = {
    pages: vi.fn(async () => [page]),
    disconnect: vi.fn(async () => {
      if (attached) debuggerApi.detach();
    }),
  };
  puppeteer.connectTab.mockImplementation(async () => {
    debuggerApi.attach();
    return {};
  });
  puppeteer.connect.mockResolvedValue(browser);
  if (connectionFails)
    puppeteer.connect.mockRejectedValueOnce(new Error("connection_failed"));
  const invalidated = vi.fn();
  const driver = new BrowserViewAutomation(wc, inspectionBundle, invalidated);
  drivers.push(driver);
  return {
    driver,
    wc,
    debugger: debuggerApi,
    browser,
    invalidated,
    locator,
    element,
    beforeEffect: vi.fn(),
  };
}
function input(
  action: "fill" | "select" | "click",
  value = "",
): Exclude<BrowserActInput, { action: "navigate" }> {
  const common = {
    sessionId: "session-1",
    observationId: "observation-1",
    generation: 1,
    target: { targetId: "t1" },
  };
  return action === "click"
    ? { ...common, action }
    : { ...common, action, value };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
