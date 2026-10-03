/** Named fixture diagnostics: no URLs, mount references, headers, tokens or bodies are retained. */
type PreviewEvent = Readonly<{
  category: string;
  method: string;
  status?: number;
  code?: string;
}>;
const events: PreviewEvent[] = [];

export function previewRequestCategory(path: string, method: string): string {
  if (path === "/control-api/session") return "session";
  if (path === "/api/v1/plugins/ui/catalog") return "catalog";
  if (path === "/api/v1/plugins/ui/mounts" && method === "POST")
    return "openMount";
  if (/^\/api\/v1\/plugins\/ui\/mounts\/[^/]+\/assets\//u.test(path))
    return "asset";
  if (/^\/api\/v1\/plugins\/ui\/mounts\/[^/]+\/actions$/u.test(path))
    return "invoke";
  if (/^\/api\/v1\/plugins\/ui\/mounts\/[^/]+$/u.test(path))
    return method === "DELETE" ? "closeMount" : "validateMount";
  return "other";
}

export function previewDiagnosticCode(value: unknown): string {
  if (typeof value === "string") {
    const match = /^(?:[A-Za-z][A-Za-z0-9]*: )?([a-z][a-z0-9_]{0,127})$/u.exec(
      value,
    );
    return match?.[1] ?? "unclassified_error";
  }
  if (value !== null && typeof value === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(value, "code");
    if (
      descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      /^[a-z][a-z0-9_]{0,127}$/u.test(descriptor.value)
    )
      return descriptor.value;
    if (
      value instanceof Error &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value.name)
    )
      return value.name;
  }
  return "unclassified_error";
}

export function recordPreviewEvent(event: PreviewEvent): void {
  events.push(Object.freeze({ ...event }));
  if (events.length > 32) events.shift();
}

export function readPreviewEvents(): readonly PreviewEvent[] {
  return Object.freeze(events.slice());
}

export const diagnosticPreviewFetch: typeof globalThis.fetch = async (
  input,
  init,
) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(
    request?.url ?? String(input),
    globalThis.location.origin,
  );
  const method = init?.method ?? request?.method ?? "GET";
  const category = previewRequestCategory(url.pathname, method);
  recordPreviewEvent({ category, method, code: "started" });
  try {
    const response = await globalThis.fetch(input, init);
    recordPreviewEvent({ category, method, status: response.status });
    return response;
  } catch (error) {
    recordPreviewEvent({
      category,
      method,
      code: previewDiagnosticCode(error),
    });
    throw error;
  }
};
