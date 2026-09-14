import { recordingElementSemantics } from "./recordingElementSemantics.ts";
import { safeRecordingText } from "./recordingPrivacy.ts";
import type {
  BrowserPageObservation,
  InspectedBrowserTarget,
} from "./browserExecutionPuppeteer.ts";

/** Bounded data projection. F02's shared library adapter owns role/name semantics. */
export function inspect(element: Element): InspectedBrowserTarget | null {
  if (
    !element.isConnected ||
    element.ownerDocument !== document ||
    element.getRootNode() !== document ||
    !["input", "textarea", "select", "button", "a"].includes(element.localName)
  )
    return null;
  const semantics = recordingElementSemantics(element);
  if (semantics.unsafe) return null;
  if (
    element.closest(
      '[inert],[hidden],[contenteditable]:not([contenteditable="false"])',
    )
  )
    return null;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (
    style.display === "none" ||
    style.visibility !== "visible" ||
    style.opacity === "0" ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  if (element instanceof HTMLSelectElement && element.multiple) return null;
  const result: InspectedBrowserTarget = {
    targetId: "",
    role: semantics.role ?? "",
    name: semantics.accessibleName ?? "",
    tag: element.localName,
  };
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const value = safeRecordingText(
      element instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(element.type)
        ? String(element.checked)
        : element.value,
    );
    if (value !== null) result.value = value;
  }
  return result;
}
export function observe(): {
  observation: BrowserPageObservation;
  elements: Element[];
} {
  const url = new URL(location.href);
  url.username = "";
  url.password = "";
  for (const [key, value] of url.searchParams)
    if (safeRecordingText(key) === null || safeRecordingText(value) === null)
      url.searchParams.set(key, "[omitted]");
  if (safeRecordingText(url.hash) === null) url.hash = "omitted";
  if (safeRecordingText(url.pathname) === null) url.pathname = "/[omitted]";
  const observation: BrowserPageObservation = {
    url: url.toString().slice(0, 1024),
    targets: [],
    truncated: false,
    unsupported: [],
  };
  const elements: Element[] = [];
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_ELEMENT,
  );
  let node: Node | null;
  let visited = 0;
  while ((node = walker.nextNode())) {
    if (++visited > 2048) {
      observation.truncated = true;
      break;
    }
    const element = node as Element;
    if (
      ["iframe", "frame", "canvas"].includes(element.localName) &&
      !observation.unsupported.includes(element.localName)
    )
      observation.unsupported.push(element.localName);
    if (
      !["input", "textarea", "select", "button", "a"].includes(
        element.localName,
      )
    )
      continue;
    const target = inspect(element);
    if (!target) continue;
    target.targetId = `t${elements.length + 1}`;
    observation.targets.push(target);
    if (
      elements.length >= 64 ||
      new TextEncoder().encode(JSON.stringify(observation)).byteLength > 8000
    ) {
      observation.targets.pop();
      observation.truncated = true;
      break;
    }
    elements.push(element);
  }
  return { observation, elements };
}
