import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as plugins from "@crewon/contracts/plugins";
import type { components } from "./generated/control-api.ts";
import * as defaults from "./index.ts";
import {
  MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
  MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES,
  MAX_PLUGIN_UI_ASSET_BYTES,
  parsePluginControlEmptyQuery,
  parsePluginControlIdempotencyKey,
  parsePluginControlMountRef,
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
  parsePluginPackageListQuery,
  parsePluginSelectionListQuery,
  parseInstallPluginPackageRequest,
  parseSelectPluginPackageRequest,
  parseOpenPluginUiMountRequest,
  parseInvokePluginUiActionRequest,
  parsePluginPackageView,
  parsePluginSelectionView,
  parsePluginPackageListResponse,
  parsePluginSelectionListResponse,
  parseGetPluginPackageResponse,
  parseGetPluginSelectionResponse,
  parsePluginInstallationResponse,
  parsePluginSelectionResponse,
} from "./plugin-control-contract.ts";
import {
  ID,
  DIGEST,
  OTHER_DIGEST,
  pkg,
  selection,
  installRequest,
  openRequest,
  rejected,
} from "./plugin-control-contract.test-support.ts";

test("HTTP query snapshots own Fastify data and enforces canonical bounded pagination", () => {
  let inheritedReads = 0;
  const query = Object.create({
    get limit() {
      inheritedReads++;
      return "50";
    },
    pluginId: "forged",
  });
  Object.defineProperty(query, "afterPackageDigest", {
    enumerable: true,
    value: DIGEST,
  });
  const parsed = parsePluginPackageListQuery(query);
  assert.deepEqual(parsed, {
    pluginId: null,
    afterPackageDigest: DIGEST,
    limit: 20,
  });
  assert.equal(inheritedReads, 0);
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(
    parsePluginSelectionListQuery({ afterPluginId: ID, limit: "50" }),
    { afterPluginId: ID, limit: 50 },
  );
  assert.deepEqual(
    parsePluginControlEmptyQuery(Object.create({ ignored: "inherited" })),
    {},
  );
  for (const limit of [
    "0",
    "01",
    "51",
    "1.5",
    "1e1",
    " 1",
    20,
    ["20", "30"],
    null,
    undefined,
  ])
    rejected(() => parsePluginPackageListQuery({ limit }));
  for (const query of [
    { pluginId: [ID, ID] },
    { afterPackageDigest: [DIGEST] },
    { extra: "value" },
    { limit: "20", profileId: "client-profile" },
  ])
    rejected(() => parsePluginPackageListQuery(query));
  rejected(() => parsePluginControlEmptyQuery({ unexpected: "value" }));
  const accessor = Object.defineProperty({}, "limit", {
    enumerable: true,
    get() {
      inheritedReads++;
      return "20";
    },
  });
  rejected(() => parsePluginPackageListQuery(accessor));
  assert.equal(inheritedReads, 0);
});

test("namespace, source references, digests and idempotency keys match the independent package boundary", () => {
  assert.equal(parsePluginControlPluginId("a" + "b".repeat(127)).length, 128);
  assert.equal(parsePluginControlPluginId("a"), "a");
  assert.equal(
    parsePluginControlIdempotencyKey("save-2026-10:receipt_1"),
    "save-2026-10:receipt_1",
  );
  assert.equal(parsePluginControlIdempotencyKey("x".repeat(128)).length, 128);
  assert.equal(
    parseInstallPluginPackageRequest({
      ...installRequest(),
      sourceId: "个人来源引用😀",
    }).sourceId,
    "个人来源引用😀",
  );
  assert.equal(parsePluginControlPackageDigest(DIGEST), DIGEST);
  assert.equal(parsePluginControlMountRef("x".repeat(32)).length, 32);
  for (const id of [
    "a".repeat(129),
    "uppercaseA",
    "../../other",
    "a/b",
    "bad\ud800",
  ])
    rejected(() => parsePluginControlPluginId(id));
  for (const key of [
    ["one", "two"],
    "",
    " x",
    "x ",
    "internal space",
    "个人保存请求😀",
    "caf\u00e9",
    "x\u00a0",
    "x\u00ff",
    "x".repeat(129),
    "x\u0085",
    "x\u200b",
    "bad\ud800",
  ])
    rejected(() => parsePluginControlIdempotencyKey(key));
  for (const digest of [
    "1".repeat(64),
    `sha256:${"A".repeat(64)}`,
    "sha256:short",
  ])
    rejected(() => parsePluginControlPackageDigest(digest));
  for (const ref of ["short", "x".repeat(129), "x/".repeat(16)])
    rejected(() => parsePluginControlMountRef(ref));
});

test("install/mount requests are detached and refuse client identity, hash authority and body idempotency", () => {
  const source = installRequest();
  const parsed = parseInstallPluginPackageRequest(source);
  source.sourceId = "changed";
  assert.equal(parsed.sourceId, "host-issued-source-1");
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(parseOpenPluginUiMountRequest(openRequest()), openRequest());
  for (const injected of [
    "actor",
    "scope",
    "profileId",
    "tenantId",
    "path",
    "requestDigest",
    "idempotencyKey",
  ]) {
    rejected(() =>
      parseInstallPluginPackageRequest({
        ...installRequest(),
        [injected]: "client-controlled",
      }),
    );
    rejected(() =>
      parseOpenPluginUiMountRequest({
        ...openRequest(),
        [injected]: "client-controlled",
      }),
    );
  }
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])
    rejected(() =>
      parseInstallPluginPackageRequest({
        ...installRequest(),
        expectedSelectionRevision: revision,
      }),
    );
  let reads = 0;
  const getter = Object.defineProperty(installRequest(), "sourceId", {
    enumerable: true,
    get() {
      reads++;
      return "unsafe";
    },
  });
  rejected(() => parseInstallPluginPackageRequest(getter));
  assert.equal(reads, 0);
});

test("selection request and view require null digest exactly for logical uninstall", () => {
  for (const state of ["enabled", "disabled"] as const) {
    assert.deepEqual(
      parseSelectPluginPackageRequest({
        state,
        selectedPackageDigest: DIGEST,
        expectedSelectionRevision: 1,
      }),
      { state, selectedPackageDigest: DIGEST, expectedSelectionRevision: 1 },
    );
    rejected(() =>
      parseSelectPluginPackageRequest({
        state,
        selectedPackageDigest: null,
        expectedSelectionRevision: 1,
      }),
    );
  }
  assert.equal(
    parseSelectPluginPackageRequest({
      state: "uninstalled",
      selectedPackageDigest: null,
      expectedSelectionRevision: Number.MAX_SAFE_INTEGER,
    }).state,
    "uninstalled",
  );
  rejected(() =>
    parseSelectPluginPackageRequest({
      state: "uninstalled",
      selectedPackageDigest: DIGEST,
      expectedSelectionRevision: 1,
    }),
  );
  rejected(() =>
    parsePluginSelectionView({ ...selection(), state: "uninstalled" }),
  );
  assert.equal(
    parsePluginSelectionView({
      ...selection(),
      state: "uninstalled",
      selectedPackageDigest: null,
    }).selectedPackageDigest,
    null,
  );
});

test("public package/selection DTOs reject persisted scope, audit identity and malformed metadata", () => {
  assert.deepEqual(parsePluginPackageView(pkg()), pkg());
  assert.deepEqual(parsePluginSelectionView(selection()), selection());
  for (const key of [
    "tenantId",
    "spaceId",
    "profileId",
    "installedByPrincipalId",
    "updatedByActorId",
    "schemaVersion",
  ]) {
    rejected(() => parsePluginPackageView({ ...pkg(), [key]: "private" }));
    rejected(() =>
      parsePluginSelectionView({ ...selection(), [key]: "private" }),
    );
  }
  rejected(() => parsePluginPackageView({ ...pkg(), version: "1.0.0-01" }));
  rejected(() =>
    parsePluginPackageView({
      ...pkg(),
      installedAt: "2026-02-30T00:00:00.000Z",
    }),
  );
  rejected(() =>
    parsePluginSelectionView({
      ...selection(),
      revision: Number.MAX_SAFE_INTEGER + 1,
    }),
  );
});

test("paged package results enforce filter, ordering, version/publisher identity and continuation", () => {
  const query = parsePluginPackageListQuery({ pluginId: ID, limit: "2" });
  const second = { ...pkg(), version: "2.0.0", packageDigest: OTHER_DIGEST };
  const source = { packages: [pkg(), second], next: OTHER_DIGEST };
  const parsed = parsePluginPackageListResponse(source, query);
  source.packages[0]!.version = "99.0.0";
  assert.equal(parsed.packages[0]!.version, pkg().version);
  assert.ok(Object.isFrozen(parsed.packages));
  for (const malformed of [
    { packages: [pkg(), pkg()], next: null },
    { packages: [second, pkg()], next: null },
    { packages: [pkg()], next: DIGEST },
    { packages: [pkg(), second], next: DIGEST },
    { packages: [{ ...pkg(), pluginId: "other.plugin" }], next: null },
    { packages: [pkg(), { ...second, version: pkg().version }], next: null },
    {
      packages: [pkg(), { ...second, publisherId: "other.publisher" }],
      next: null,
    },
  ])
    rejected(() => parsePluginPackageListResponse(malformed, query));
  rejected(() =>
    parsePluginPackageListResponse(
      { packages: [pkg()], next: null },
      { ...query, afterPackageDigest: DIGEST },
    ),
  );
  assert.deepEqual(
    parsePluginPackageListResponse({ packages: [], next: null }, query),
    { packages: [], next: null },
  );
});

test("selection pages and nullable get responses bind to the requested identity", () => {
  const query = parsePluginSelectionListQuery({ limit: "1" });
  assert.deepEqual(
    parsePluginSelectionListResponse(
      { selections: [selection()], next: ID },
      query,
    ),
    { selections: [selection()], next: ID },
  );
  rejected(() =>
    parsePluginSelectionListResponse(
      { selections: [selection(), selection()], next: null },
      { ...query, limit: 2 },
    ),
  );
  rejected(() =>
    parsePluginSelectionListResponse(
      { selections: [selection()], next: "later" },
      query,
    ),
  );
  assert.deepEqual(
    parseGetPluginPackageResponse({ package: null }, { packageDigest: DIGEST }),
    { package: null },
  );
  assert.deepEqual(
    parseGetPluginSelectionResponse({ selection: null }, { pluginId: ID }),
    { selection: null },
  );
  assert.deepEqual(
    parseGetPluginPackageResponse(
      { package: pkg() },
      { packageDigest: DIGEST },
    ),
    { package: pkg() },
  );
  assert.deepEqual(
    parseGetPluginSelectionResponse(
      { selection: selection() },
      { pluginId: ID },
    ),
    { selection: selection() },
  );
  rejected(() =>
    parseGetPluginPackageResponse(
      { package: pkg() },
      { packageDigest: OTHER_DIGEST },
    ),
  );
  rejected(() =>
    parseGetPluginSelectionResponse(
      { selection: selection() },
      { pluginId: "other.plugin" },
    ),
  );
});

test("install responses preserve historical receipt snapshots and do not accidentally require activating the installed version", () => {
  const response = {
    kind: "install",
    disposition: "committed",
    package: pkg(),
    selection: selection(),
  };
  assert.deepEqual(
    parsePluginInstallationResponse(response, installRequest()),
    response,
  );
  const existing = {
    ...response,
    disposition: "replayed",
    selection: {
      ...selection(),
      revision: 7,
      state: "enabled",
      selectedPackageDigest: OTHER_DIGEST,
    },
  };
  assert.deepEqual(
    parsePluginInstallationResponse(existing, {
      ...installRequest(),
      expectedSelectionRevision: 7,
    }),
    existing,
  );
  const restored = { ...response, selection: { ...selection(), revision: 8 } };
  assert.deepEqual(
    parsePluginInstallationResponse(restored, {
      ...installRequest(),
      expectedSelectionRevision: 7,
    }),
    restored,
  );
  for (const invalid of [
    { ...response, package: { ...pkg(), packageDigest: OTHER_DIGEST } },
    {
      ...response,
      selection: { ...selection(), publisherId: "other.publisher" },
    },
    { ...response, selection: { ...selection(), state: "enabled" } },
    { ...response, selection: { ...selection(), revision: 3 } },
  ])
    rejected(() => parsePluginInstallationResponse(invalid, installRequest()));
});

test("selection response requires CAS advancement and separates saved mutation from projection health", () => {
  const request = {
    state: "enabled" as const,
    selectedPackageDigest: DIGEST,
    expectedSelectionRevision: 1,
  };
  const response = {
    mutation: {
      kind: "select",
      disposition: "committed",
      selection: { ...selection(), revision: 2, state: "enabled" },
    },
    projection: { outcome: "applied" },
  };
  assert.deepEqual(
    parsePluginSelectionResponse(response, { pluginId: ID, request }),
    response,
  );
  const pending = {
    ...response,
    projection: { outcome: "pending", reasonCode: "plugin_projection_pending" },
  };
  assert.deepEqual(
    parsePluginSelectionResponse(pending, { pluginId: ID, request }),
    pending,
  );
  const replay = {
    ...response,
    mutation: { ...response.mutation, disposition: "replayed" },
    projection: { outcome: "unchanged" },
  };
  assert.deepEqual(
    parsePluginSelectionResponse(replay, { pluginId: ID, request }),
    replay,
  );
  for (const invalid of [
    {
      ...response,
      mutation: {
        ...response.mutation,
        selection: { ...response.mutation.selection, revision: 1 },
      },
    },
    {
      ...response,
      mutation: {
        ...response.mutation,
        selection: { ...response.mutation.selection, state: "disabled" },
      },
    },
    { ...response, projection: { outcome: "unchanged" } },
    { ...replay, projection: { outcome: "applied" } },
    {
      ...pending,
      projection: { outcome: "pending", reasonCode: "private_stack_trace" },
    },
  ])
    rejected(() =>
      parsePluginSelectionResponse(invalid, { pluginId: ID, request }),
    );
  const max = {
    ...response,
    mutation: {
      ...response.mutation,
      selection: {
        ...response.mutation.selection,
        revision: Number.MAX_SAFE_INTEGER,
      },
    },
  };
  assert.ok(
    parsePluginSelectionResponse(max, {
      pluginId: ID,
      request: {
        ...request,
        expectedSelectionRevision: Number.MAX_SAFE_INTEGER - 1,
      },
    }),
  );
  rejected(() =>
    parsePluginSelectionResponse(max, {
      pluginId: ID,
      request: {
        ...request,
        expectedSelectionRevision: Number.MAX_SAFE_INTEGER,
      },
    }),
  );
});

test("public HTTP API stays separate from SDK entrypoints and OpenAPI generation records every bounded route", () => {
  assert.equal(
    defaults.parseInstallPluginPackageRequest,
    parseInstallPluginPackageRequest,
  );
  assert.equal("parseInstallPluginPackageRequest" in plugins, false);
  assert.equal("parsePluginUiLease" in defaults, false);
  const api = JSON.parse(
    readFileSync(
      new URL("../openapi/control-api.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const paths = Object.entries(api.paths).filter(([path]) =>
    path.startsWith("/api/v1/plugins"),
  );
  assert.equal(paths.length, 10);
  assert.equal(
    paths.reduce(
      (count, [, operations]) =>
        count + Object.keys(operations as object).length,
      0,
    ),
    12,
  );
  assert.equal(api.components.schemas.PluginNamespaceId.maxLength, 128);
  assert.equal(
    api.paths["/api/v1/extensions/{pluginId}/configuration"].get.parameters[0]
      .schema.maxLength,
    48,
  );
  for (const path of [
    "/api/v1/plugins/installations",
    "/api/v1/plugins/selections/{pluginId}",
  ]) {
    const operation =
      api.paths[path][path.includes("installations") ? "post" : "put"];
    assert.ok(
      operation.parameters.some(
        (item: { name?: string }) => item.name === "Idempotency-Key",
      ),
    );
    assert.equal(
      operation.parameters.find(
        (item: { name?: string }) => item.name === "Idempotency-Key",
      ).schema.$ref,
      "#/components/schemas/PluginIdempotencyKey",
    );
  }
  assert.equal(
    api.components.schemas.PluginIdempotencyKey.pattern,
    "^[!-~]{1,128}$",
  );
  assert.equal(
    api.components.schemas.InstallPluginPackageRequest.additionalProperties,
    false,
  );
  assert.deepEqual(
    Object.keys(api.components.schemas.PluginPackageView.properties).sort(),
    Object.keys(pkg()).sort(),
  );
  assert.deepEqual(
    Object.keys(api.components.schemas.PluginSelectionView.properties).sort(),
    Object.keys(selection()).sort(),
  );
  assert.equal(
    api.components.schemas.PluginUiLease["x-max-encoded-bytes"],
    MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
  );
  assert.equal(
    api.components.schemas.PluginUiCatalogResponse["x-max-encoded-bytes"],
    MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES,
  );
  assert.equal(MAX_PLUGIN_UI_ASSET_BYTES, 33554432);
  const close = api.paths["/api/v1/plugins/ui/mounts/{mountRef}"].delete;
  assert.equal(close.requestBody.required, false);
  assert.deepEqual(close.requestBody.content["application/json"].schema.oneOf, [
    { type: "null" },
    { type: "object", additionalProperties: false, maxProperties: 0 },
  ]);
  const install: components["schemas"]["InstallPluginPackageRequest"] =
    installRequest();
  const action: components["schemas"]["InvokePluginUiActionRequest"] = {
    action: "save",
    input: [null, { ok: true }],
  };
  assert.deepEqual(parseInstallPluginPackageRequest(install), install);
  assert.deepEqual(parseInvokePluginUiActionRequest(action), action);
});
