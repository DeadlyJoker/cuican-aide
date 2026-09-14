import { recordingElementSemantics } from "./recordingElementSemantics.ts";
import {
  ORDINARY_INPUT_TYPES,
  safeRecordingText,
  sensitiveRecordingControl,
} from "./recordingPrivacy.ts";
export { safeRecordingText } from "./recordingPrivacy.ts";
import type { RecordingSourceEvent } from "../src/lib/desktop/recordingBridge.ts";

const MAX_EVENT_BYTES = 8_192;
const MAX_DIMENSION = 16_384;
const HTML_TAGS = new Set([
  "html",
  "body",
  "main",
  "header",
  "footer",
  "nav",
  "section",
  "article",
  "aside",
  "div",
  "span",
  "p",
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "form",
  "fieldset",
  "legend",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dialog",
  "option",
  "optgroup",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "img",
  "svg",
  "path",
  "canvas",
  "iframe",
]);

function boundedNumber(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(max, value)));
}

function layoutFor(
  element: Element,
  window: Window,
): RecordingSourceEvent["layout"] {
  const width = Math.max(1, boundedNumber(window.innerWidth, MAX_DIMENSION));
  const height = Math.max(1, boundedNumber(window.innerHeight, MAX_DIMENSION));
  const rect = element.getBoundingClientRect();
  const x = boundedNumber(rect.x, width);
  const y = boundedNumber(rect.y, height);
  return {
    width,
    height,
    x,
    y,
    targetWidth: boundedNumber(Math.min(rect.right, width) - x, width - x),
    targetHeight: boundedNumber(Math.min(rect.bottom, height) - y, height - y),
  };
}

/** Geometry only: no embedded page image, text, URL, style, or external resources. */
export function recordingLayoutSvg(
  layout: RecordingSourceEvent["layout"],
): string {
  const keys = [
    "width",
    "height",
    "x",
    "y",
    "targetWidth",
    "targetHeight",
  ] as const;
  if (
    !layout ||
    Object.keys(layout).length !== keys.length ||
    keys.some((key) => {
      const value = layout[key];
      return (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_DIMENSION
      );
    }) ||
    layout.width < 1 ||
    layout.height < 1
  )
    throw new Error("invalid-recording-layout");
  const width = boundedNumber(layout.width, MAX_DIMENSION);
  const height = boundedNumber(layout.height, MAX_DIMENSION);
  const x = boundedNumber(layout.x, width);
  const y = boundedNumber(layout.y, height);
  const targetWidth = boundedNumber(layout.targetWidth, width - x);
  const targetHeight = boundedNumber(layout.targetHeight, height - y);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#f5f5f4"/><rect x="${x}" y="${y}" width="${targetWidth}" height="${targetHeight}" fill="#d6d3d1" stroke="#57534e"/></svg>`;
}

function structuralSelector(
  element: Element,
  document: Document,
): string | null {
  if (element.getRootNode() !== document) return null;
  const path: string[] = [];
  let current: Element | null = element;
  while (current && path.length < 16) {
    const tag = current.tagName.toLowerCase();
    if (!HTML_TAGS.has(tag)) return null;
    let index = 1;
    let siblings = 0;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (++siblings > 4_096) return null;
      if (sibling.tagName === current.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    path.unshift(`${tag}:nth-of-type(${index})`);
    if (current === document.documentElement) {
      const result = path.join(" > ");
      return result.length <= 512 ? result : null;
    }
    current = current.parentElement;
  }
  return null;
}

function safeControlScreenshot(
  control: Element,
  name: string | null,
  window: Window,
): boolean {
  if (
    !name ||
    !["button", "a", "select"].includes(control.tagName.toLowerCase())
  )
    return false;
  const computed = window.getComputedStyle(control);
  const color = computed.backgroundColor;
  if (
    !/^rgb\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3}\s*\)$/.test(color) &&
    !/^rgba\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3},\s*1(?:\.0+)?\s*\)$/.test(color)
  )
    return false;
  if (
    [
      computed.borderTopLeftRadius,
      computed.borderTopRightRadius,
      computed.borderBottomLeftRadius,
      computed.borderBottomRightRadius,
    ].some((radius) => !/^0(?:px)?(?: 0(?:px)?)?$/.test(radius))
  )
    return false;
  // An ancestor can composite pixels that do not belong to the control. Stop
  // rather than claiming a crop is safe when the ancestor chain is unbounded.
  let ancestor: Element | null = control;
  let depth = 0;
  while (ancestor && depth++ < 16) {
    const style = window.getComputedStyle(ancestor);
    if (
      !["", "none"].includes(style.transform) ||
      style.opacity !== "1" ||
      !["", "none"].includes(style.filter) ||
      !["", "none"].includes(style.backdropFilter) ||
      !["", "none"].includes(style.maskImage) ||
      !["", "none"].includes(style.clipPath) ||
      !["", "normal"].includes(style.mixBlendMode)
    )
      return false;
    ancestor = ancestor.parentElement;
  }
  if (ancestor) return false;
  const inputs = control.ownerDocument.querySelectorAll(
    "input,textarea,select",
  );
  if (inputs.length > 256) return false;
  for (const input of inputs) {
    if (
      !sensitiveRecordingControl(input) &&
      !recordingElementSemantics(input).unsafe
    )
      continue;
    const inputRect = input.getBoundingClientRect();
    const style = window.getComputedStyle(input);
    if (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      inputRect.width > 0 &&
      inputRect.height > 0 &&
      inputRect.right > 0 &&
      inputRect.bottom > 0 &&
      inputRect.x < window.innerWidth &&
      inputRect.y < window.innerHeight
    )
      return false;
  }
  const children = Array.from(control.querySelectorAll("*"));
  if (
    children.length > 32 ||
    children.some(
      (child) =>
        ![
          "span",
          "strong",
          "em",
          "b",
          "i",
          "small",
          "option",
          "optgroup",
        ].includes(child.tagName.toLowerCase()) ||
        sensitiveRecordingControl(child),
    )
  )
    return false;
  // Only small, visible controls with ordinary text and no images/composited
  // content are eligible. The host must still recheck generation and crop.
  const text = safeRecordingText(control.textContent ?? "");
  if (text === null || text.length > 120) return false;
  const rect = control.getBoundingClientRect();
  if (
    rect.width < 1 ||
    rect.height < 1 ||
    rect.width > 512 ||
    rect.height > 256 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.right > window.innerWidth ||
    rect.bottom > window.innerHeight
  )
    return false;
  for (const element of [control, ...children]) {
    const style = window.getComputedStyle(element);
    if (
      style.visibility !== "visible" ||
      style.display === "none" ||
      style.opacity !== "1" ||
      !["", "none"].includes(style.backgroundImage) ||
      !["", "none"].includes(style.borderImageSource) ||
      !["", "none"].includes(style.filter) ||
      !["", "none"].includes(style.backdropFilter) ||
      !["", "normal"].includes(style.mixBlendMode)
    )
      return false;
    for (const pseudo of ["::before", "::after"]) {
      if (
        !["", "none", "normal"].includes(
          window.getComputedStyle(element, pseudo).content,
        )
      )
        return false;
    }
  }
  if (typeof control.ownerDocument.elementFromPoint !== "function")
    return false;
  for (const [x, y] of [
    [rect.x + 1, rect.y + 1],
    [rect.right - 1, rect.y + 1],
    [rect.x + 1, rect.bottom - 1],
    [rect.right - 1, rect.bottom - 1],
    [rect.x + rect.width / 2, rect.y + rect.height / 2],
  ]) {
    const hit = control.ownerDocument.elementFromPoint(x, y);
    if (!hit || (hit !== control && !control.contains(hit))) return false;
  }
  return true;
}

function unsupported(reason: string): RecordingSourceEvent {
  return {
    kind: "unsupported",
    target: null,
    input: null,
    reason,
    screenshotSafe: false,
    layout: null,
  };
}

export function installRecordingSource(options: {
  document: Document;
  window: Window;
  emit: (event: RecordingSourceEvent) => void;
}): {
  setEnabled(enabled: boolean): void;
  verifyScreenshot(selector: string): boolean;
  dispose(): void;
} {
  const { document, window, emit } = options;
  let enabled = false;
  let disposed = false;
  let iframeReported = false;
  let recentEvents: number[] = [];
  let observer: MutationObserver | null = null;
  let mutationRevision = 0;
  const candidates = new Map<
    string,
    { element: Element; revision: number; geometry: number[] }
  >();
  const geometry = (element: Element): number[] => {
    const rect = element.getBoundingClientRect();
    return [
      window.innerWidth,
      window.innerHeight,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      rect.right,
      rect.bottom,
    ];
  };
  const flushMutations = () => {
    if (observer?.takeRecords().length) mutationRevision += 1;
  };

  const send = (event: RecordingSourceEvent, element?: Element): boolean => {
    if (!enabled || disposed) return false;
    const now = window.performance.now();
    recentEvents = recentEvents.filter((time) => now - time < 1_000);
    if (recentEvents.length >= 10) return false;
    const output =
      recentEvents.length === 9 ? unsupported("source-rate-limit") : event;
    if (
      new TextEncoder().encode(JSON.stringify(output)).byteLength >
      MAX_EVENT_BYTES
    )
      return false;
    recentEvents.push(now);
    flushMutations();
    if (
      output === event &&
      output.screenshotSafe &&
      output.target &&
      element &&
      observer
    ) {
      const selector = output.target.selector;
      // One candidate per selector per arm. Replacing it would let a late host
      // request for an older event borrow a newer candidate's safety verdict.
      if (!candidates.has(selector) && candidates.size < 10) {
        candidates.set(selector, {
          element,
          revision: mutationRevision,
          geometry: geometry(element),
        });
      }
    }
    try {
      emit(output);
    } catch {
      enabled = false;
    }
    return output === event;
  };

  const reportIframe = () => {
    if (enabled && !iframeReported && document.querySelector("iframe,frame")) {
      iframeReported = send(unsupported("iframe-not-supported"));
    }
  };

  const handle = (event: Event) => {
    if (!enabled || disposed || !event.isTrusted) return;
    try {
      const raw = event.target;
      if (!raw || !("nodeType" in raw) || raw.nodeType !== 1) {
        send(unsupported("target-unavailable"));
        return;
      }
      const element = raw as Element;
      if (element.ownerDocument !== document) return;
      if (
        event.composedPath()[0] !== element ||
        element.getRootNode() !== document
      ) {
        send(unsupported("shadow-dom-not-supported"));
        return;
      }
      if (element.closest("canvas,iframe,frame")) {
        send(unsupported("embedded-content-not-supported"));
        return;
      }
      if (element.closest('[contenteditable]:not([contenteditable="false"])')) {
        send(unsupported("contenteditable-not-supported"));
        return;
      }
      const control = element.closest("a,button,input,select,textarea");
      if (!control) {
        send(unsupported("control-not-supported"));
        return;
      }
      const tag = control.tagName.toLowerCase();
      const type = tag === "input" ? (control as HTMLInputElement).type : tag;
      if (tag === "input" && type === "file") {
        send(unsupported("file-input-not-supported"));
        return;
      }
      if (tag === "select" && (control as HTMLSelectElement).multiple) {
        send(unsupported("multiple-select-not-supported"));
        return;
      }
      const selector = structuralSelector(control, document);
      if (!selector) {
        send(unsupported("target-unlocatable"));
        return;
      }
      const accessible = recordingElementSemantics(control);
      const sensitive = accessible.unsafe;
      let input: RecordingSourceEvent["input"] = null;
      let kind: RecordingSourceEvent["kind"] = "click";
      if (event.type === "change") {
        if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
        kind = tag === "select" ? "select" : "input";
        if (sensitive) input = { classification: "runtime-required" };
        if (!sensitive) {
          // This is the only value read, after the sensitive-control check above.
          const value =
            tag === "input" && (type === "checkbox" || type === "radio")
              ? String((control as HTMLInputElement).checked)
              : (
                  control as
                    | HTMLInputElement
                    | HTMLTextAreaElement
                    | HTMLSelectElement
                ).value;
          const safe = safeRecordingText(value);
          input =
            safe === null
              ? { classification: "runtime-required" }
              : {
                  classification:
                    tag === "select" ||
                    [
                      "date",
                      "month",
                      "week",
                      "time",
                      "datetime-local",
                    ].includes(type)
                      ? "parameter-candidate"
                      : "ordinary",
                  value: safe,
                };
        }
      }
      send(
        {
          kind,
          target: {
            tag,
            selector,
            description:
              tag === "input"
                ? `input:${ORDINARY_INPUT_TYPES.has(type) ? type : "protected"}`
                : tag,
            role: accessible.role,
            accessibleName: accessible.accessibleName,
          },
          input,
          reason:
            sensitive || input?.classification === "runtime-required"
              ? "sensitive-or-unbounded-input-omitted"
              : null,
          screenshotSafe:
            !sensitive &&
            safeControlScreenshot(control, accessible.accessibleName, window),
          layout: layoutFor(control, window),
        },
        control,
      );
    } catch {
      send(unsupported("target-unavailable"));
    }
  };

  document.addEventListener("click", handle, true);
  document.addEventListener("change", handle, true);
  return {
    setEnabled(value) {
      if (disposed || enabled === value) return;
      enabled = value;
      observer?.disconnect();
      observer = null;
      mutationRevision += 1;
      candidates.clear();
      if (enabled) {
        iframeReported = false;
        reportIframe();
        const MutationObserverClass = document.defaultView?.MutationObserver;
        if (MutationObserverClass) {
          observer = new MutationObserverClass((records) => {
            if (records.length) mutationRevision += 1;
            reportIframe();
          });
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        }
      }
    },
    verifyScreenshot(selector) {
      if (
        !enabled ||
        disposed ||
        typeof selector !== "string" ||
        selector.length > 512
      )
        return false;
      flushMutations();
      const candidate = candidates.get(selector);
      if (!candidate || candidate.revision !== mutationRevision) return false;
      try {
        const { element } = candidate;
        const currentGeometry = geometry(element);
        const semantics = recordingElementSemantics(element);
        const safe =
          element.isConnected &&
          element.ownerDocument === document &&
          document.querySelector(selector) === element &&
          structuralSelector(element, document) === selector &&
          currentGeometry.every(
            (value, index) =>
              Number.isFinite(value) && value === candidate.geometry[index],
          ) &&
          !semantics.unsafe &&
          safeControlScreenshot(element, semantics.accessibleName, window);
        // Once a check fails, this event cannot become eligible again later.
        if (!safe) candidate.revision = -1;
        return safe;
      } catch {
        candidate.revision = -1;
        return false;
      }
    },
    dispose() {
      enabled = false;
      disposed = true;
      observer?.disconnect();
      candidates.clear();
      document.removeEventListener("click", handle, true);
      document.removeEventListener("change", handle, true);
    },
  };
}
