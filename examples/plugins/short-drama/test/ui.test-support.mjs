import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Window } from "happy-dom";

export const browser = new Window({ url: "https://crewon.test/workspace" });
for (const name of [
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
])
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? browser : browser[name],
    writable: true,
    configurable: true,
  });

// The DOM fixture models native open/close state; real browser top-layer behavior is a separate check.
export const closedDialogs = [];
browser.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
browser.HTMLDialogElement.prototype.close = function () {
  if (this.open) closedDialogs.push(this);
  this.open = false;
};

export const props = (tokens = { "--text": "#202020" }, mode = "light") => ({
  schemaVersion: "crewon.plugin-ui-props.v1",
  contributionId: "workbench",
  theme: { mode, tokens },
  data: { locale: "zh" },
});

export async function settle() {
  await setImmediate();
  await setImmediate();
  await setImmediate();
}

export function fixture(definition) {
  const container = document.createElement("div");
  document.body.append(container);
  let calls = 0;
  const services = {
    async invoke() {
      calls += 1;
      throw new Error("demo_must_not_invoke_tasks");
    },
  };
  const instance = definition.mount(container, props(), services);
  assert.equal(typeof instance.update, "function");
  assert.equal(typeof instance.dispose, "function");
  const button = (label) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === label,
    );
    assert.ok(found, "missing button: " + label);
    return found;
  };
  const click = async (element) => {
    assert.ok(element);
    element.click();
    await settle();
  };
  const input = async (element, value) => {
    assert.ok(element);
    const prototype =
      element instanceof browser.HTMLTextAreaElement
        ? browser.HTMLTextAreaElement.prototype
        : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(
      element,
      value,
    );
    element.dispatchEvent(new browser.Event("input", { bubbles: true }));
    element.dispatchEvent(new browser.Event("change", { bubbles: true }));
    await settle();
  };
  return {
    container,
    instance,
    services,
    button,
    click,
    input,
    get serviceCalls() {
      return calls;
    },
    async dispose() {
      instance.dispose();
      container.remove();
      await settle();
    },
  };
}
