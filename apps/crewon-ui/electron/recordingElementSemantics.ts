import { computeAccessibleName, getRole } from "dom-accessibility-api";
import {
  safeRecordingText,
  sensitiveRecordingControl,
} from "./recordingPrivacy.ts";

const MAX_NAME_BYTES = 160;

/** Privacy/budget guard only. The library owns name precedence and semantics. */
function safeNameScope(control: Element): boolean {
  if (sensitiveRecordingControl(control)) return false;
  const labels = (control as HTMLInputElement).labels;
  if (labels && labels.length > 8) return false;
  if (
    ["input", "button", "select", "textarea"].includes(control.localName) &&
    labels === undefined
  )
    return false;
  const pending: Array<{ node: Node; depth: number }> = [
    { node: control, depth: 0 },
  ];
  for (const label of labels ?? []) pending.push({ node: label, depth: 0 });
  const seen = new Set<Node>();
  let sourceBytes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (seen.has(node)) continue;
    if (depth > 16 || seen.size >= 64) return false;
    seen.add(node);
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      if (safeRecordingText(text) === null) return false;
      sourceBytes += new TextEncoder().encode(text).byteLength;
    } else if (node.nodeType === 1) {
      const element = node as Element;
      if (
        element.getRootNode() !== control.ownerDocument ||
        sensitiveRecordingControl(element) ||
        element.shadowRoot ||
        [
          "iframe",
          "frame",
          "canvas",
          "slot",
          "script",
          "style",
          "template",
          "object",
          "embed",
        ].includes(element.localName) ||
        element.hasAttribute("contenteditable")
      )
        return false;
      // Accessible names may include embedded textbox values. Exclude those
      // paths before the library can access any other control's value.
      if (
        element !== control &&
        ["input", "textarea", "select", "button"].includes(element.localName)
      )
        return false;
      for (const attribute of [
        "aria-label",
        "title",
        "alt",
        "label",
        "aria-valuetext",
        "aria-valuenow",
      ]) {
        const text = element.getAttribute(attribute);
        if (text === null) continue;
        if (safeRecordingText(text) === null) return false;
        sourceBytes += new TextEncoder().encode(text).byteLength;
      }
      for (const attribute of ["aria-labelledby", "aria-owns"]) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        if (value.length > 512) return false;
        const references = value.trim().split(/\s+/);
        if (references.length > 8) return false;
        for (const id of references) {
          const referenced = control.ownerDocument.getElementById(id);
          if (!referenced) continue;
          if (
            referenced === control &&
            ["input", "textarea", "select"].includes(control.localName)
          )
            return false;
          pending.push({ node: referenced, depth: depth + 1 });
        }
      }
    }
    if (
      sourceBytes > 2_048 ||
      node.childNodes.length > 64 ||
      pending.length + node.childNodes.length > 64
    )
      return false;
    for (const child of node.childNodes)
      pending.push({ node: child, depth: depth + 1 });
  }
  return true;
}

export type RecordingElementSemantics = {
  accessibleName: string | null;
  role: string | null;
  unsafe: boolean;
};

/** A bounded privacy adapter; dom-accessibility-api owns name and role semantics. */
export function recordingElementSemantics(
  control: Element,
): RecordingElementSemantics {
  try {
    if (!safeNameScope(control))
      return { accessibleName: null, role: null, unsafe: true };
    const name = safeRecordingText(
      computeAccessibleName(control, {
        computedStyleSupportsPseudoElements: false,
      }),
    );
    if (
      name === null ||
      new TextEncoder().encode(name).byteLength > MAX_NAME_BYTES
    )
      return { accessibleName: null, role: null, unsafe: true };
    const role = getRole(control);
    const safeRole =
      role !== null && role.length <= 64 ? safeRecordingText(role) : null;
    return { accessibleName: name || null, role: safeRole, unsafe: false };
  } catch {
    return { accessibleName: null, role: null, unsafe: true };
  }
}
