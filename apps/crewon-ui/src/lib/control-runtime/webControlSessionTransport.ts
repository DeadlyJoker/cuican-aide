type Session = Readonly<{
  baseUrl: string;
  csrfToken: string;
  pluginUiAssets?: "entry-bytes.v1";
}>;

/** Original account credentials stay in the caller's generation-bound fetch.
 * Only an explicit BFF pre-dispatch rejection may renew/replay a request.
 */
export function createWebControlSessionTransport(input: {
  fetch: typeof globalThis.fetch;
  pageOrigin: string;
  parseSession: (value: unknown) => Session;
  bootstrapMethod?: "account-exchange" | "cookie-read";
}): { bootstrap(): Promise<Session>; fetch: typeof globalThis.fetch } {
  let current: Session | null = null;
  let pending: Promise<Session> | null = null;
  const bootstrap = (): Promise<Session> => {
    if (pending !== null) return pending;
    pending = (async () => {
      const url = new URL("/control-api/session", input.pageOrigin);
      const directExchange = input.bootstrapMethod === "account-exchange";
      const signal = AbortSignal.timeout(15_000);
      let response = await input.fetch(url, {
        ...(directExchange ? { method: "POST" } : {}),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(directExchange ? { Origin: input.pageOrigin } : {}),
        },
        signal,
      });
      // Older cookie-only BFFs explicitly reject the opt-in exchange route.
      // Authentication failures never fall back to another session authority.
      if (directExchange && response.status === 405) {
        await response.body?.cancel();
        response = await input.fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        });
      } else if (!directExchange && (await requiresExchange(response))) {
        await response.body?.cancel();
        response = await input.fetch(url, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json", Origin: input.pageOrigin },
          signal,
        });
      }
      if (!response.ok) throw new Error("control_runtime_session_unavailable");
      const session = input.parseSession(await boundedJson(response));
      current = {
        ...session,
        ...(response.headers.get("x-crewon-plugin-ui-assets") ===
        "entry-bytes.v1"
          ? { pluginUiAssets: "entry-bytes.v1" as const }
          : {}),
      };
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
    ![401, 403].includes(response.status) ||
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
      ((response.status === 401 &&
        body.error.code === "identity_session_required") ||
        (response.status === 403 && body.error.code === "browser_csrf_invalid"))
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
