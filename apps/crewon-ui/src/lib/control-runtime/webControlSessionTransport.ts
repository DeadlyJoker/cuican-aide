type Session = Readonly<{ baseUrl: string; csrfToken: string }>;

/** Original account credentials stay in the caller's generation-bound fetch.
 * Only an explicit BFF pre-dispatch rejection may renew/replay a request.
 */
export function createWebControlSessionTransport(input: {
  fetch: typeof globalThis.fetch;
  pageOrigin: string;
  parseSession: (value: unknown) => Session;
}): { bootstrap(): Promise<Session>; fetch: typeof globalThis.fetch } {
  let current: Session | null = null;
  let pending: Promise<Session> | null = null;
  const bootstrap = (): Promise<Session> => {
    if (pending !== null) return pending;
    pending = (async () => {
      const url = new URL("/control-api/session", input.pageOrigin);
      let response = await input.fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (await requiresExchange(response)) {
        await response.body?.cancel();
        response = await input.fetch(url, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json", Origin: input.pageOrigin },
        });
      }
      if (!response.ok) throw new Error("control_runtime_session_unavailable");
      current = input.parseSession(await boundedJson(response));
      return current;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
  const send: typeof globalThis.fetch = (request, init) => {
    const headers = new Headers(
      request instanceof Request ? request.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (current !== null && headers.has("x-csrf-token"))
      headers.set("x-csrf-token", current.csrfToken);
    return input.fetch(request, { ...init, headers });
  };
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = new URL(
      request instanceof Request ? request.url : String(request),
      input.pageOrigin,
    );
    // Never exchange account credentials for another origin or for a non-Control request.
    const mayRenew =
      url.origin === input.pageOrigin && url.pathname.startsWith("/api/v1/");
    const retryRequest =
      mayRenew && request instanceof Request ? request.clone() : request;
    const sentSession = current;
    const response = await send(request, init);
    if (!mayRenew || !(await requiresExchange(response))) return response;
    await response.body?.cancel();
    if (current === sentSession) await bootstrap();
    return send(retryRequest, init);
  };
  return { bootstrap, fetch };
}
async function requiresExchange(response: Response): Promise<boolean> {
  if (
    response.status !== 401 ||
    response.headers.get("x-crewon-account-exchange") !== "required"
  )
    return false;
  try {
    const body = await boundedJson(response.clone());
    return (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "code" in body.error &&
      body.error.code === "identity_session_required"
    );
  } catch {
    return false;
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (
    !/^application\/json(?:;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    ) ||
    !response.body
  )
    throw new Error("control_runtime_session_invalid");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 4096) throw new Error("control_runtime_session_invalid");
      parts.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error("control_runtime_session_invalid");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
