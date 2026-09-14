import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseBrowserExecutionAuthorityResponse } from "./browser-execution-authority.ts";

const facts = {
  schemaVersion: "crewon.browser-execution-authority.v1",
  runId: "run-1",
  threadId: "thread-1",
  workspaceBindingId: null,
  status: "running",
  cancelRequested: false,
  revision: 2,
};
test("C05 authority preserves explicit null/bound workspace facts and rejects inferred authority", () => {
  assert.deepEqual(
    parseBrowserExecutionAuthorityResponse(facts, "run-1"),
    facts,
  );
  assert.deepEqual(
    parseBrowserExecutionAuthorityResponse({
      ...facts,
      workspaceBindingId: "workspace-1",
    }).workspaceBindingId,
    "workspace-1",
  );
  for (const input of [
    null,
    {},
    { ...facts, schemaVersion: "v2" },
    { ...facts, workspaceBindingId: undefined },
    { ...facts, workspaceBindingId: "../root" },
    { ...facts, status: "unknown" },
    { ...facts, cancelRequested: "false" },
    { ...facts, revision: 0 },
    { ...facts, grant: true },
    { ...facts, status: "canceled", cancelRequested: false },
  ])
    assert.throws(() => parseBrowserExecutionAuthorityResponse(input));
  assert.throws(() =>
    parseBrowserExecutionAuthorityResponse(facts, "other-run"),
  );
});
test("C05 authority OpenAPI keeps the facts route additive and exactly matches its parser", () => {
  const spec = JSON.parse(
    readFileSync(
      new URL("../openapi/control-api.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const endpoint =
    spec.paths["/api/v1/runs/{runId}/browser-execution-authority"];
  assert.equal(endpoint.get.operationId, "getBrowserExecutionAuthority");
  assert.deepEqual(Object.keys(endpoint), ["get"]);
  const schema = spec.components.schemas.BrowserExecutionAuthorityResponse;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(facts).sort());
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    Object.keys(facts).sort(),
  );
  assert.equal(
    spec.components.schemas.RunView.properties.workspaceBindingId,
    undefined,
  );
});
