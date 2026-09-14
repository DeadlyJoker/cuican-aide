import {
  connect,
  ExtensionTransport,
  LocatorEvent,
  type Browser,
  type ElementHandle,
  type Page,
} from "puppeteer-core";
import type { WebContents } from "electron";
import type { BrowserActInput } from "@crewon/contracts";

type Debuggee = { tabId: number; sessionId?: string };
type DebuggerListener = (
  source: Debuggee,
  method: string,
  params: object,
) => void;
type Registration = {
  wc: WebContents;
  guard: () => void;
  inputCommands: number;
};
const registrations = new Map<number, Registration>();
const listeners = new Map<
  DebuggerListener,
  Map<number, (...args: any[]) => void>
>();
let shimInstalled = false;
function register(wc: WebContents): Registration {
  if (registrations.has(wc.id) || wc.debugger.isAttached())
    throw new Error("browser_debugger_busy");
  if (!shimInstalled) {
    const globals = globalThis as unknown as { chrome?: unknown };
    if (globals.chrome !== undefined)
      throw new Error("browser_debugger_environment_conflict");
    const selected = (source: Debuggee) => {
      const value = registrations.get(source.tabId);
      if (!value) throw new Error("browser_debugger_scope_invalid");
      return value;
    };
    // Thin API mapping only. Puppeteer's public ExtensionTransport owns its single-tab CDP compatibility.
    globals.chrome = {
      debugger: {
        attach: async (source: Debuggee, version: string) =>
          selected(source).wc.debugger.attach(version),
        detach: async (source: Debuggee) => {
          const entry = selected(source);
          if (entry.wc.debugger.isAttached()) entry.wc.debugger.detach();
        },
        sendCommand: async (
          source: Debuggee,
          method: string,
          params: object,
        ) => {
          const entry = selected(source);
          entry.guard();
          const input = method.startsWith("Input.");
          if (input) entry.inputCommands++;
          try {
            return await entry.wc.debugger.sendCommand(
              method,
              params,
              source.sessionId,
            );
          } finally {
            if (input) entry.inputCommands--;
          }
        },
        onEvent: {
          addListener(listener: DebuggerListener) {
            const handlers = new Map<number, (...args: any[]) => void>();
            for (const entry of registrations.values()) {
              const handler = (
                _event: unknown,
                method: string,
                params: object,
                sessionId: string,
              ) =>
                listener(
                  { tabId: entry.wc.id, sessionId: sessionId || undefined },
                  method,
                  params,
                );
              entry.wc.debugger.on("message", handler);
              handlers.set(entry.wc.id, handler);
            }
            listeners.set(listener, handlers);
          },
          removeListener(listener: DebuggerListener) {
            for (const [id, handler] of listeners.get(listener) ?? [])
              registrations
                .get(id)
                ?.wc.debugger.removeListener("message", handler);
            listeners.delete(listener);
          },
        },
      },
    };
    shimInstalled = true;
  }
  const entry = { wc, guard: () => {}, inputCommands: 0 };
  registrations.set(wc.id, entry);
  return entry;
}
export function isBrowserAutomationInput(wc: WebContents): boolean {
  return (registrations.get(wc.id)?.inputCommands ?? 0) > 0;
}
export type InspectedBrowserTarget = {
  targetId: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
};
export type BrowserPageObservation = {
  url: string;
  targets: InspectedBrowserTarget[];
  truncated: boolean;
  unsupported: string[];
};
/** A single existing WebContentsView. Never launches Chromium or opens a debugging port. */
export class BrowserViewAutomation {
  readonly #entry: Registration;
  readonly #connected: Promise<{ browser: Browser; page: Page }>;
  readonly #targets = new Map<string, ElementHandle<Element>>();
  readonly #inspect: (element: Element) => InspectedBrowserTarget | null;
  readonly #observe: () => {
    observation: BrowserPageObservation;
    elements: Element[];
  };
  readonly #observed = new Map<string, InspectedBrowserTarget>();
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(
    readonly webContents: WebContents,
    inspectionBundle: string,
    private readonly invalidated: (reason: string) => void,
  ) {
    // These fixed functions are built from the checked-in inspection entry, never from Tool input.
    this.#inspect = new Function(
      "element",
      `${inspectionBundle};return CrewonBrowserInspection.inspect(element);`,
    ) as (element: Element) => InspectedBrowserTarget | null;
    this.#observe = new Function(
      `${inspectionBundle};return CrewonBrowserInspection.observe();`,
    ) as () => { observation: BrowserPageObservation; elements: Element[] };
    this.#entry = register(webContents);
    this.#connected = ExtensionTransport.connectTab(webContents.id)
      .then((transport) =>
        connect({ transport, defaultViewport: null, protocolTimeout: 5000 }),
      )
      .then(async (browser) => {
        try {
          const pages = await browser.pages();
          if (pages.length !== 1)
            throw new Error("browser_target_count_invalid");
          return { browser, page: pages[0]! };
        } catch (error) {
          await browser.disconnect();
          throw error;
        }
      });
    void this.#connected.catch(() => {
      if (!this.#closed) this.invalidated("browser-connection-failed");
      void this.close();
    });
    webContents.debugger.on("detach", this.#onDetach);
    webContents.on("before-input-event", this.#onNativeInput);
    webContents.on("before-mouse-event", this.#onNativeInput);
  }
  #onNativeInput = () => {
    if (!this.#closed && !isBrowserAutomationInput(this.webContents))
      this.invalidated("user-takeover");
  };
  #onDetach = () => {
    if (!this.#closed) {
      this.invalidated("debugger-detached");
      void this.close();
    }
  };
  async observe(): Promise<BrowserPageObservation> {
    const { page } = await this.#connected;
    if (this.#closed) throw new Error("browser_driver_closed");
    await this.#releaseTargets();
    const handle = await page.evaluateHandle(this.#observe);
    try {
      const observationHandle = await handle.getProperty("observation");
      const observation = await observationHandle.jsonValue();
      await observationHandle.dispose();
      const elements = await handle.getProperty("elements");
      for (const [index, element] of await elements.getProperties()) {
        const target = observation.targets[Number(index)];
        const node = element.asElement() as ElementHandle<Element> | null;
        if (target && node) {
          this.#targets.set(target.targetId, node);
          this.#observed.set(target.targetId, target);
        } else await element.dispose();
      }
      await elements.dispose();
      return observation;
    } finally {
      await handle.dispose();
    }
  }
  async act(
    input: Exclude<BrowserActInput, { action: "navigate" }>,
    targetId: string,
    signal: AbortSignal,
    beforeEffect: () => void,
  ): Promise<void> {
    await this.#connected;
    if (this.#closed) throw new Error("browser_driver_closed");
    if (signal.aborted) throw new Error("browser_execution_canceled");
    try {
      await this.webContents.debugger.sendCommand(
        "Emulation.setFocusEmulationEnabled",
        { enabled: true },
      );
    } catch {
      throw new Error("browser_user_attention_required");
    }
    try {
      return await this.#act(input, targetId, signal, beforeEffect);
    } finally {
      if (this.webContents.debugger.isAttached())
        await this.webContents.debugger.sendCommand(
          "Emulation.setFocusEmulationEnabled",
          { enabled: false },
        );
    }
  }
  async #act(
    input: Exclude<BrowserActInput, { action: "navigate" }>,
    targetId: string,
    signal: AbortSignal,
    beforeEffect: () => void,
  ): Promise<void> {
    const { page } = await this.#connected;
    if ((await page.evaluate(() => document.visibilityState)) !== "visible")
      throw new Error("browser_user_attention_required");
    const target = this.#targets.get(targetId);
    if (!target) throw new Error("browser_target_unavailable");
    const checked = await target.evaluate(this.#inspect);
    if (!checked) throw new Error("browser_sensitive_or_unavailable_control");
    const expected = this.#observed.get(targetId);
    if (
      !expected ||
      checked.role !== expected.role ||
      checked.name !== expected.name ||
      checked.tag !== expected.tag
    )
      throw new Error("browser_target_changed");
    if (
      "role" in input.target &&
      (checked.role !== input.target.role || checked.name !== input.target.name)
    )
      throw new Error("browser_target_changed");
    if (input.action === "select" && checked.tag !== "select")
      throw new Error("browser_select_unsupported");
    if (input.action === "fill" && !["input", "textarea"].includes(checked.tag))
      throw new Error("browser_fill_unsupported");
    if (input.action === "fill" || input.action === "select") {
      const problem = await target.evaluate(nativeActionProblem, {
        action: input.action,
        value: input.value,
      });
      if (problem) throw new Error(problem);
    }
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    let dispatched = false;
    this.#entry.guard = () => {
      if (combined.aborted) throw new Error("browser_execution_canceled");
    };
    const locator = target.asLocator().setTimeout(5000);
    locator.on(LocatorEvent.Action, () => {
      if (dispatched) {
        stop.abort("effect-retry-forbidden");
        throw new Error("browser_effect_retry_forbidden");
      }
      this.#entry.guard();
      beforeEffect();
      dispatched = true;
    });
    try {
      if (input.action === "fill" || input.action === "select")
        await locator.fill(input.value, { signal: combined });
      else await locator.click({ signal: combined });
    } finally {
      this.#entry.guard = () => {};
      await this.#releaseTargets();
    }
  }
  async #releaseTargets() {
    await Promise.allSettled(
      [...this.#targets.values()].map((t) => t.dispose()),
    );
    this.#targets.clear();
    this.#observed.clear();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#dispose();
    return this.#closing;
  }
  async #dispose(): Promise<void> {
    this.webContents.debugger.removeListener("detach", this.#onDetach);
    this.webContents.removeListener("before-input-event", this.#onNativeInput);
    this.webContents.removeListener("before-mouse-event", this.#onNativeInput);
    await this.#releaseTargets();
    try {
      if (this.webContents.debugger.isAttached())
        await this.webContents.debugger.sendCommand(
          "Emulation.setFocusEmulationEnabled",
          { enabled: false },
        );
    } catch {
      // Detaching below also releases emulation if the debugger stopped responding.
    }
    try {
      await (await this.#connected).browser.disconnect();
    } catch {
      // A failed connection or a lost debugger must still release its registration.
    } finally {
      if (this.webContents.debugger.isAttached()) {
        try {
          this.webContents.debugger.detach();
        } catch {
          /* Already destroyed. */
        }
      }
      for (const [listener, handlers] of listeners) {
        const handler = handlers.get(this.webContents.id);
        if (handler)
          this.webContents.debugger.removeListener("message", handler);
        handlers.delete(this.webContents.id);
        if (handlers.size === 0) listeners.delete(listener);
      }
      registrations.delete(this.webContents.id);
    }
  }
}

/** Fixed native-control guard evaluated in the existing page, never caller code. */
function nativeActionProblem(
  element: Element,
  request: { action: "fill" | "select"; value: string },
): string | null {
  if (request.action === "fill") {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) ||
      element.readOnly ||
      element.matches(":disabled")
    )
      return "browser_fill_unsupported";
    if (
      element instanceof HTMLInputElement &&
      ![
        "text",
        "search",
        "url",
        "tel",
        "email",
        "number",
        "date",
        "datetime-local",
        "month",
        "time",
        "week",
      ].includes(element.type)
    )
      return "browser_fill_unsupported";
    return null;
  }
  if (
    !(element instanceof HTMLSelectElement) ||
    element.multiple ||
    element.matches(":disabled")
  )
    return "browser_select_unsupported";
  const options = Array.from(element.options).filter(
    (option) =>
      option.value === request.value &&
      !option.disabled &&
      !option.parentElement?.matches("optgroup:disabled"),
  );
  return options.length === 1 ? null : "browser_select_option_unavailable";
}
