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
  data: { locale: "zh", shortDramaPreview: true },
});

export async function settle() {
  await setImmediate();
  await setImmediate();
  await setImmediate();
}

export function fixture(definition, configuration = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  let calls = 0;
  const services = configuration.services ?? {
    async invoke() {
      calls += 1;
      throw new Error("demo_must_not_invoke_tasks");
    },
  };
  const instance = definition.mount(
    container,
    configuration.props ?? props(),
    services,
  );
  assert.equal(typeof instance.update, "function");
  assert.equal(typeof instance.dispose, "function");
  const button = (label) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === label,
    );
    assert.ok(found, "missing button: " + label);
    return found;
  };
  const reveal = async (element) => {
    const ancestors = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === "DETAILS" && !parent.open) ancestors.unshift(parent);
    for (const details of ancestors) {
      details.querySelector(":scope > summary").click();
      await settle();
    }
  };
  const click = async (element) => {
    assert.ok(element);
    await reveal(element);
    element.click();
    await settle();
  };
  const input = async (element, value) => {
    assert.ok(element);
    await reveal(element);
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

/** Recovery is read in the background; the user explicitly opens its project from home. */
export async function openRecoveredProject(f) {
  assert.ok(f.container.querySelector(".drama-project-home"));
  const recovery = f.container.querySelector(".drama-recovery-disclosure");
  assert.ok(recovery);
  if (!recovery.open) await f.click(recovery.querySelector("summary"));
  await f.click(f.button("查看待处理项目"));
  assert.equal(f.container.querySelector(".drama-project-home"), null);
}
