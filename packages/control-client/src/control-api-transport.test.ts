import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient, ControlApiTransportError, ControlApiProtocolError } from "./control-api-client.ts";

test("HTTP transport failure stays distinct from an explicit rejection and never retries automatically", async () => {
  const cause = new TypeError("fetch failed");
  let calls = 0;
  const client = new ControlApiClient({ baseUrl: "https://crewon.example", origin: "https://crewon.example", csrfToken: "csrf", fetch: async () => { calls++; throw cause; } });
  await assert.rejects(client.plugins.uiCatalog({}), (error: unknown) => error instanceof ControlApiTransportError && error.cause === cause);
  assert.equal(calls, 1);
  const failedHttp = new ControlApiClient({ baseUrl: "https://crewon.example", fetch: async () => new Response("<html>Bad gateway</html>", { status: 502 }) });
  await assert.rejects(failedHttp.plugins.uiCatalog({}), (error: unknown) => error instanceof ControlApiProtocolError && error.httpStatus === 502);
});
