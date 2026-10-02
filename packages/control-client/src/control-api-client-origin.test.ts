import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "./control-api-client.ts";

test("request origin describes the actual validated destination without exposing session configuration", async () => {
  for (const baseUrl of [
    "https://control.test/path/",
    "http://127.0.0.1:3210/",
  ]) {
    const destinations: URL[] = [];
    const client = new ControlApiClient({
      baseUrl,
      origin: "https://ui.test",
      accessToken: "fixture-private-token",
      csrfToken: "fixture-private-csrf",
      fetch: async (input) => {
        destinations.push(new URL(String(input)));
        return Response.json({ plugins: [], next: null });
      },
    });
    assert.equal(client.requestOrigin, new URL(baseUrl).origin);
    await client.plugins.uiCatalog();
    assert.equal(destinations[0]?.origin, client.requestOrigin);
    assert.equal(destinations[0]?.pathname, "/api/v1/plugins/ui/catalog");
    assert.equal(JSON.stringify(client).includes("fixture-private"), false);
    assert.equal(JSON.stringify(client).includes("requestOrigin"), false);
  }
});
