import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as sdkContracts from "@crewon/contracts/plugins";
import * as httpContracts from "./index.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import type { components } from "./generated/control-api.ts";
import {
  MAX_PLUGIN_COMPOSITION_STATUS_RESPONSE_BYTES,
  PLUGIN_COMPOSITION_STATUS_SCHEMA,
  parsePluginCompositionStatusResponse,
} from "./plugin-composition-status-contract.ts";

const digest = `sha256:${"a".repeat(64)}`;
const query = { afterPluginId: null, limit: 20 };
const selection = {
  pluginId: "sample.plugin",
  publisherId: "sample.publisher",
  revision: 2,
  state: "enabled",
  selectedPackageDigest: digest,
  updatedAt: "2026-10-11T00:00:00.000Z",
};
const response = () => ({
  schemaVersion: PLUGIN_COMPOSITION_STATUS_SCHEMA,
  metadata: { state: "published", lockDigest: digest, revision: 1 },
  plugins: [{ selection, node: { state: "unobserved" } }],
  next: null,
});
const rejected = (work: () => unknown) =>
  assert.throws(work, ContractValidationError);

test("versioned status keeps published metadata distinct from observed Node readiness", () => {
  const parsed = parsePluginCompositionStatusResponse(response(), query);
  assert.equal(parsed.metadata.state, "published");
  assert.equal(parsed.plugins[0]?.node.state, "unobserved");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.plugins));
  assert.ok(Object.isFrozen(parsed.plugins[0]!.selection));
  for (const node of [
    { state: "ready" },
    { state: "preparing" },
    { state: "waitingDependency", reasonCode: "plugin_dependency_unavailable" },
    { state: "failed", reasonCode: "plugin_activation_failed" },
    { state: "failed", reasonCode: "plugin_cleanup_failed" },
    { state: "failed", reasonCode: "plugin_authority_unavailable" },
    { state: "failed", reasonCode: "plugin_composition_unavailable" },
  ]) {
    const result = parsePluginCompositionStatusResponse(
      { ...response(), plugins: [{ selection, node }] },
      query,
    );
    assert.deepEqual(result.plugins[0]?.node, node);
  }
  // A metadata transaction can fail independently of an existing live instance.
  assert.equal(
    parsePluginCompositionStatusResponse(
      {
        ...response(),
        metadata: {
          state: "failed",
          reasonCode: "plugin_composition_metadata_unavailable",
        },
        plugins: [{ selection, node: { state: "ready" } }],
      },
      query,
    ).plugins[0]?.node.state,
    "ready",
  );
});

test("disabled and uninstalled intent cannot be reported ready or waiting for dependencies", () => {
  for (const state of ["disabled", "uninstalled"] as const) {
    const current = {
      ...selection,
      state,
      selectedPackageDigest: state === "uninstalled" ? null : digest,
    };
    assert.equal(
      parsePluginCompositionStatusResponse(
        {
          ...response(),
          plugins: [{ selection: current, node: { state: "inactive" } }],
        },
        query,
      ).plugins[0]?.node.state,
      "inactive",
    );
    assert.deepEqual(
      parsePluginCompositionStatusResponse(
        {
          ...response(),
          plugins: [
            {
              selection: current,
              node: { state: "failed", reasonCode: "plugin_cleanup_failed" },
            },
          ],
        },
        query,
      ).plugins[0]?.node,
      { state: "failed", reasonCode: "plugin_cleanup_failed" },
    );
    for (const node of [
      { state: "ready" },
      { state: "preparing" },
      { state: "unobserved" },
      {
        state: "waitingDependency",
        reasonCode: "plugin_dependency_unavailable",
      },
      { state: "failed", reasonCode: "plugin_activation_failed" },
    ])
      rejected(() =>
        parsePluginCompositionStatusResponse(
          { ...response(), plugins: [{ selection: current, node }] },
          query,
        ),
      );
  }
  rejected(() =>
    parsePluginCompositionStatusResponse(
      { ...response(), plugins: [{ selection, node: { state: "inactive" } }] },
      query,
    ),
  );
});

test("status uses original ordered paging bounds and never returns a whole graph", () => {
  const entry = response().plugins[0]!;
  const second = {
    ...entry,
    selection: { ...selection, pluginId: "sample.second" },
  };
  const page = parsePluginCompositionStatusResponse(
    { ...response(), plugins: [entry, second], next: "sample.second" },
    { afterPluginId: null, limit: 2 },
  );
  assert.equal(page.next, "sample.second");
  for (const input of [
    { ...response(), plugins: [second, entry] },
    { ...response(), plugins: [entry, entry] },
    { ...response(), next: "sample.plugin" },
    { ...response(), plugins: Array.from({ length: 51 }, () => entry) },
    { ...response(), nodes: [] },
  ])
    rejected(() => parsePluginCompositionStatusResponse(input, query));
  rejected(() =>
    parsePluginCompositionStatusResponse(response(), {
      afterPluginId: "sample.plugin",
      limit: 20,
    }),
  );
  rejected(() =>
    parsePluginCompositionStatusResponse(
      { ...response(), plugins: [entry, second] },
      { afterPluginId: null, limit: 1 },
    ),
  );
});

test("status rejects arbitrary exceptions, scope, paths, accessors and schema downgrades", () => {
  for (const key of [
    "tenantId",
    "spaceId",
    "profileId",
    "installRoot",
    "token",
  ])
    rejected(() =>
      parsePluginCompositionStatusResponse(
        { ...response(), [key]: "private" },
        query,
      ),
    );
  for (const node of [
    { state: "ready", packagePath: "/private/path" },
    { state: "failed", reasonCode: "SECRET_TOKEN_value" },
    {
      state: "failed",
      reasonCode: "plugin_activation_failed",
      message: "private",
    },
    { state: "waitingDependency", reasonCode: "plugin_activation_failed" },
    { state: "unknown" },
  ])
    rejected(() =>
      parsePluginCompositionStatusResponse(
        { ...response(), plugins: [{ selection, node }] },
        query,
      ),
    );
  for (const metadata of [
    { state: "published" },
    { state: "unobserved", lockDigest: digest },
    { state: "failed", reasonCode: "private_exception_message" },
    { state: "published", lockDigest: digest, revision: 0 },
  ])
    rejected(() =>
      parsePluginCompositionStatusResponse({ ...response(), metadata }, query),
    );
  rejected(() =>
    parsePluginCompositionStatusResponse(
      { ...response(), schemaVersion: "crewon.plugin-composition-status.v0" },
      query,
    ),
  );
  rejected(() =>
    parsePluginCompositionStatusResponse(
      {
        ...response(),
        metadata: {
          state: "failed",
          reasonCode: "x".repeat(MAX_PLUGIN_COMPOSITION_STATUS_RESPONSE_BYTES),
        },
      },
      query,
    ),
  );
  let reads = 0;
  const input = Object.defineProperty(response(), "metadata", {
    enumerable: true,
    get() {
      reads++;
      return { state: "unobserved" };
    },
  });
  rejected(() => parsePluginCompositionStatusResponse(input, query));
  assert.equal(reads, 0);
});

test("OpenAPI and generated status type describe the additive bounded authenticated route", () => {
  assert.equal(
    httpContracts.parsePluginCompositionStatusResponse,
    parsePluginCompositionStatusResponse,
  );
  assert.equal(
    Object.hasOwn(sdkContracts, "parsePluginCompositionStatusResponse"),
    false,
  );
  const api = JSON.parse(
    readFileSync(
      new URL("../openapi/control-api.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const route = api.paths["/api/v1/plugins/composition/status"].get;
  assert.equal(route.operationId, "listPluginCompositionStatus");
  assert.equal(
    route.parameters.find((item: { name: string }) => item.name === "limit")
      .schema.maximum,
    50,
  );
  assert.equal(
    api.components.schemas.PluginCompositionStatusResponse.additionalProperties,
    false,
  );
  assert.equal(
    api.components.schemas.PluginCompositionStatusResponse.properties.plugins
      .maxItems,
    50,
  );
  const typed: components["schemas"]["PluginCompositionStatusResponse"] = {
    schemaVersion: PLUGIN_COMPOSITION_STATUS_SCHEMA,
    metadata: { state: "unobserved" },
    plugins: [],
    next: null,
  };
  assert.deepEqual(parsePluginCompositionStatusResponse(typed, query), typed);
});
