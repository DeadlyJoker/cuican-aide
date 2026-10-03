import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

type TestBrowser = Readonly<Record<string, unknown>> & {
  document: Document;
  Event: typeof Event;
  HTMLInputElement: typeof HTMLInputElement;
  HTMLTextAreaElement: typeof HTMLTextAreaElement;
  HTMLDialogElement: typeof HTMLDialogElement;
  happyDOM: { close(): Promise<void> };
};

/** Loads the external consumer's DOM library; the UI module still comes from verified Host asset bytes. */
export async function installedCreativeProjectBrowser(modulePath: string) {
  await readFile(modulePath);
  const module = (await import(pathToFileURL(modulePath).href)) as Record<
    string,
    unknown
  >;
  assert.equal(typeof module.Window, "function");
  const WindowConstructor = module.Window as new (options: {
    url: string;
  }) => TestBrowser;
  const browser = new WindowConstructor({
    url: "https://crewon.test/workspace",
  });
  const names = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLDialogElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
  ];
  const originals = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      value: name === "window" ? browser : browser[name],
      writable: true,
      configurable: true,
    });
  // Native dialog top-layer behavior is covered separately; this fixture models DOM open state.
  browser.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  browser.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  return {
    browser,
    async close() {
      try {
        await browser.happyDOM.close();
      } finally {
        for (const [name, original] of originals) {
          if (original === undefined) Reflect.deleteProperty(globalThis, name);
          else Object.defineProperty(globalThis, name, original);
        }
      }
    },
  };
}

export function installedCreativeProjectControls(
  browser: TestBrowser,
  container: () => HTMLElement,
) {
  const button = (label: string) => {
    const found = Array.from(
      container().querySelectorAll<HTMLButtonElement>("button"),
    ).find((item) => item.textContent?.trim() === label);
    assert.ok(found, `missing installed UI button: ${label}`);
    return found;
  };
  const conceptButton = (name: string) => {
    const found = Array.from(
      container().querySelectorAll<HTMLButtonElement>(
        ".concept-panel > button.version-card",
      ),
    ).find((item) => item.querySelector("strong")?.textContent === name);
    assert.ok(found, `missing installed concept asset: ${name}`);
    return found;
  };
  const prompt = () =>
    container().querySelector<HTMLTextAreaElement>("#concept-prompt");
  const enter = async (selector: string, text: string) => {
    const element = container().querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(selector);
    assert.ok(element, `missing installed UI input: ${selector}`);
    const prototype =
      element instanceof browser.HTMLTextAreaElement
        ? browser.HTMLTextAreaElement.prototype
        : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      text,
    );
    element.dispatchEvent(new browser.Event("input", { bubbles: true }));
    element.dispatchEvent(new browser.Event("change", { bubbles: true }));
    await setTimeout(5);
  };
  return { button, conceptButton, prompt, enter };
}

export async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      assert.fail(`installed UI did not reach: ${description}`);
    await setTimeout(5);
  }
}
