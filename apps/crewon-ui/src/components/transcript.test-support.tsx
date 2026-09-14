import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// The process is intentionally absent from the DOM until the user opens it.
// Exercise the real toggle path before asserting its cards and visual snapshots.
export function renderExpandedTranscript(element: ReactNode): string {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(element));
    act(() => {
      for (const button of container.querySelectorAll<HTMLButtonElement>(
        ".turn-process-summary[aria-expanded=false]",
      ))
        button.click();
    });
    act(() => {
      for (const details of container.querySelectorAll<HTMLDetailsElement>(
        ".process-action-group",
      )) {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      }
    });
    return container.innerHTML;
  } finally {
    act(() => root.unmount());
    container.remove();
  }
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
