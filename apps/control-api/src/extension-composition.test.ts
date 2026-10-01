import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  parseExtensionHostRequest,
  type ExtensionHostRequest,
} from "@crewon/contracts";
import { extensionCanonicalJson, parseExtensionManifest } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import {
  createStandaloneControlApi,
  createStandaloneControlApiWithExtensions,
  createPostgresControlApi,
  type StandaloneControlApiConfig,
} from "./standalone-composition.ts";
import { LoopbackExtensionHostClient } from "./extension-worker-client.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const sessionToken = "extension-control-session-token-0001";
const csrfToken = "extension-control-csrf-token-00001";
const workerToken = "extension-control-worker-token-0001";
const browserOrigin = "http://127.0.0.1:5175";
const promptSchema = {
  type: "object",
  properties: { prompt: { type: "string", maxLength: 2000, enum: null } },
  required: ["prompt"],
  additionalProperties: false,
};
const manifest = parseExtensionManifest({
  schemaVersion: "crewon.extension-manifest.v0",
  hostApi: "crewon.extensions.v0",
  pluginId: "example.image",
  version: "0.1.0",
  title: "Composition fixture",
  description: "Synthetic Worker catalog for Control composition behavior.",
  task: {
    instructions: "Observe the original operation.",
    inputSchema: promptSchema,
  },
  configurationSchema: {
    type: "object",
    properties: { baseUrl: { type: "string", maxLength: 2048, enum: null } },
    required: ["baseUrl"],
    additionalProperties: false,
  },
  credentialSlots: [],
  tools: [
    {
      operationId: "observe",
      adapterId: "example.image-api",
      description: "Observe the operation.",
      inputSchema: promptSchema,
      outputSchema: promptSchema,
      execution: "serial",
      effect: "readOnly",
      recovery: "replaySafe",
      capability: "example.image.read",
    },
  ],
  resultViews: ["externalOperation"],
});
const registration = {
  manifest,
  manifestDigest: `sha256:${createHash("sha256").update(extensionCanonicalJson(manifest)).digest("hex")}`,
  implementationDigest: `sha256:${"a".repeat(64)}`,
};
const base = `/api/v1/extensions/${manifest.pluginId}`;
const saveBody = {
  pluginVersion: manifest.version,
  expectedRevision: 0,
  parameters: { baseUrl: "https://images.example/" },
  credentialBindings: [],
};

function config(context: TestContext): StandaloneControlApiConfig {
  const directory = mkdtempSync(join(tmpdir(), "crewon-extension-control-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    actor: structuredClone(actor),
    defaultAgentVersionId: "unused-agent-version",
    sessionToken,
    csrfToken,
    allowedOrigins: [browserOrigin],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "artifact-key",
    databasePath: join(directory, "control.sqlite"),
  };
}

function headers(key = "save-1") {
  return {
    "authorization": `Bearer ${sessionToken}`,
    "origin": browserOrigin,
    "x-csrf-token": csrfToken,
    "idempotency-key": key,
    "content-type": "application/json",
  };
}

async function workerFixture(
  context: TestContext,
  responseOverride?: (
    request: ExtensionHostRequest,
    response: ServerResponse,
  ) => boolean | Promise<boolean>,
) {
  const requests: ExtensionHostRequest[] = [];
  const server = createServer(async (incoming, outgoing) => {
    assert.equal(incoming.url, "/private/v0/extensions");
    assert.equal(incoming.headers.authorization, `Bearer ${workerToken}`);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = parseExtensionHostRequest(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    requests.push(request);
    if (await responseOverride?.(request, outgoing)) return;
    const common = {
      protocol: "crewon.extension-host-response.v0",
      operation: request.operation,
      actor: request.actor,
    };
    const response =
      request.operation === "catalog"
        ? { ...common, registrations: [registration] }
        : request.operation === "validateConfiguration"
          ? {
              ...common,
              registration: request.registration,
              configurationDigest: request.configuration.contentDigest,
            }
          : {
              ...common,
              registration: request.registration,
              configurationDigest: request.configuration.contentDigest,
              agentVersionId: request.agentVersionId,
              result: {
                outcome: "unavailable",
                reasonCode: "extension_runtime_unavailable",
              },
            };
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    requests,
    origin: `http://127.0.0.1:${address.port}`,
    token: workerToken,
  };
}

function tables(path: string): string[] {
  const database = new DatabaseSync(path);
  try {
    return (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'extension_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map(({ name }) => name);
  } finally {
    database.close();
  }
}

test("default standalone creator remains synchronous with no plugin routes or migrations", async (context) => {
  const cfg = config(context);
  const runtime = createStandaloneControlApi(cfg);
  assert.equal("then" in runtime, false);
  for (const [method, url, payload] of [
    ["GET", `${base}/configuration`, undefined],
    ["GET", `${base}/activation`, undefined],
    [
      "POST",
      `${base}/tasks`,
      {
        threadId: "missing",
        expectedThreadRevision: 1,
        intent: { kind: "generate", input: { prompt: "image" } },
      },
    ],
  ] as const) {
    const result = await runtime.app.inject({
      method,
      url,
      headers: headers(),
      payload,
    });
    assert.equal(result.statusCode, 404, result.body);
    assert.equal(result.json().error.code, "route_not_found");
  }
  await runtime.app.close();
  assert.deepEqual(tables(cfg.databasePath), []);
});

test("explicit async composition negotiates the authenticated catalog and migrates shared SQLite authorities", async (context) => {
  const cfg = config(context);
  const worker = await workerFixture(context);
  const runtime = await createStandaloneControlApiWithExtensions({
    ...cfg,
    extensionWorker: worker,
  });
  context.after(() => runtime.app.close());
  assert.deepEqual(
    worker.requests.map(({ operation }) => operation),
    ["catalog"],
  );
  assert.deepEqual(worker.requests[0]!.actor, actor);
  assert.equal(
    runtime.app.hasRoute({
      method: "POST",
      url: "/api/v1/extensions/:pluginId/tasks",
    }),
    true,
  );
  const origin = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const initial = await fetch(`${origin}${base}/configuration`, {
    headers: headers(),
  });
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { configuration: null });
  const saved = await fetch(`${origin}${base}/configuration`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(saveBody),
  });
  assert.equal(saved.status, 200);
  const value = (await saved.json()) as {
    disposition: string;
    configuration: {
      tenantId: string;
      spaceId: string;
      implementationDigest: string;
    };
  };
  assert.equal(value.disposition, "created");
  assert.equal(value.configuration.tenantId, actor.tenantId);
  assert.equal(value.configuration.spaceId, actor.spaceId);
  assert.equal(
    value.configuration.implementationDigest,
    registration.implementationDigest,
  );
  const repeated = await runtime.app.inject({
    method: "PUT",
    url: `${base}/configuration`,
    headers: headers(),
    payload: saveBody,
  });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().disposition, "replayed");
  assert.deepEqual(
    worker.requests.map(({ operation }) => operation),
    ["catalog", "validateConfiguration"],
  );
  assert.ok(tables(cfg.databasePath).includes("extension_configurations"));
  assert.ok(tables(cfg.databasePath).includes("extension_external_operations"));
});

test("plugin routes use the existing session, CSRF and actor scope boundary", async (context) => {
  const worker = await workerFixture(context);
  const runtime = await createStandaloneControlApiWithExtensions({
    ...config(context),
    extensionWorker: worker,
  });
  context.after(() => runtime.app.close());
  assert.equal(
    (await runtime.app.inject({ method: "GET", url: `${base}/configuration` }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await runtime.app.inject({
        method: "PUT",
        url: `${base}/configuration`,
        headers: { ...headers(), "x-csrf-token": "foreign" },
        payload: saveBody,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await runtime.app.inject({
        method: "PUT",
        url: `${base}/configuration`,
        headers: headers(),
        payload: { ...saveBody, tenantId: "foreign" },
      })
    ).statusCode,
    400,
  );
  assert.equal(worker.requests.length, 1);
  const saved = await runtime.app.inject({
    method: "PUT",
    url: `${base}/configuration`,
    headers: {
      ...headers(),
      "x-actor-id": "foreign",
      "x-tenant-id": "foreign",
    },
    payload: saveBody,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(worker.requests[1]!.actor, actor);
});

test("async startup freezes the configured actor before catalog negotiation awaits", async (context) => {
  let catalogStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    catalogStarted = resolve;
  });
  let releaseCatalog!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  const worker = await workerFixture(context, async (request) => {
    if (request.operation === "catalog") {
      catalogStarted();
      await gate;
    }
    return false;
  });
  const cfg = config(context);
  const creation = createStandaloneControlApiWithExtensions({
    ...cfg,
    extensionWorker: worker,
  });
  await started;
  Object.assign(cfg.actor, { actorId: "foreign", tenantId: "foreign" });
  releaseCatalog();
  const runtime = await creation;
  context.after(() => runtime.app.close());
  const saved = await runtime.app.inject({
    method: "PUT",
    url: `${base}/configuration`,
    headers: headers(),
    payload: saveBody,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(
    worker.requests.map(({ actor: received }) => received),
    [actor, actor],
  );
});

test("catalog authentication or actor echo failure rejects startup before plugin migrations", async (context) => {
  for (const failure of ["authentication", "actor"] as const) {
    const cfg = config(context);
    const worker = await workerFixture(context, (request, response) => {
      if (failure === "authentication") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            protocol: "crewon.extension-host-response.v0",
            operation: request.operation,
            actor: { ...request.actor, actorId: "foreign" },
            registrations: [registration],
          }),
        );
      }
      return true;
    });
    await assert.rejects(
      createStandaloneControlApiWithExtensions({
        ...cfg,
        extensionWorker: worker,
      }),
      failure === "authentication"
        ? /extension_host_authentication_failed/u
        : /extension_host_response_invalid/u,
    );
    assert.deepEqual(tables(cfg.databasePath), []);
    const reopened = new SqliteRunStore(cfg.databasePath);
    await reopened.close();
  }
});

test("migration rejection is preserved and startup awaits client close before closing its store", async (context) => {
  const cfg = config(context);
  const database = new DatabaseSync(cfg.databasePath);
  database.exec(
    "CREATE TABLE extension_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT; INSERT INTO extension_schema_version VALUES (1, 999);",
  );
  database.close();
  const worker = await workerFixture(context);
  const order: string[] = [];
  let closeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  let releaseClose!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const clientClose = LoopbackExtensionHostClient.prototype.close;
  context.mock.method(
    LoopbackExtensionHostClient.prototype,
    "close",
    async function (this: LoopbackExtensionHostClient) {
      await clientClose.call(this);
      order.push("client-start");
      closeStarted();
      await gate;
      order.push("client-end");
    },
  );
  const storeClose = SqliteRunStore.prototype.close;
  let closedStore: SqliteRunStore | undefined;
  context.mock.method(
    SqliteRunStore.prototype,
    "close",
    async function (this: SqliteRunStore) {
      closedStore = this;
      order.push("store");
      await storeClose.call(this);
    },
  );
  const creation = createStandaloneControlApiWithExtensions({
    ...cfg,
    extensionWorker: worker,
  });
  const rejected = assert.rejects(
    creation,
    /extension_schema_version_unsupported/u,
  );
  await started;
  assert.deepEqual(order, ["client-start"]);
  releaseClose();
  await rejected;
  assert.deepEqual(order, ["client-start", "client-end", "store"]);
  assert.ok(closedStore);
  await assert.rejects(
    closedStore.loadThread({ tenantId: actor.tenantId, threadId: "unused" }),
    /store_closed/u,
  );
});

test("composition failure closes the negotiated peer and store even when artifact cleanup rejects", async (context) => {
  const cfg = config(context);
  const worker = await workerFixture(context);
  const cleanupFailure = new Error("artifact-cleanup-failed");
  context.mock.method(cfg.artifactStore, "close", async () => {
    throw cleanupFailure;
  });
  let peerClosed = false;
  const clientClose = LoopbackExtensionHostClient.prototype.close;
  context.mock.method(
    LoopbackExtensionHostClient.prototype,
    "close",
    async function (this: LoopbackExtensionHostClient) {
      await clientClose.call(this);
      peerClosed = true;
    },
  );
  const storeClose = SqliteRunStore.prototype.close;
  let storeClosed = false;
  context.mock.method(
    SqliteRunStore.prototype,
    "close",
    async function (this: SqliteRunStore) {
      await storeClose.call(this);
      storeClosed = true;
    },
  );
  await assert.rejects(
    createStandaloneControlApiWithExtensions({
      ...cfg,
      allowedOrigins: [],
      extensionWorker: worker,
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal((error.errors[0] as Error).message, "allowed_origins_empty");
      assert.equal(error.errors[1], cleanupFailure);
      return true;
    },
  );
  assert.equal(peerClosed, true);
  assert.equal(storeClosed, true);
});

test("normal close awaits the peer before its SQLite owner and still closes the store on peer failure", async (context) => {
  const cfg = config(context);
  const worker = await workerFixture(context);
  const runtime = await createStandaloneControlApiWithExtensions({
    ...cfg,
    extensionWorker: worker,
  });
  const order: string[] = [];
  const clientClose = LoopbackExtensionHostClient.prototype.close;
  context.mock.method(
    LoopbackExtensionHostClient.prototype,
    "close",
    async function (this: LoopbackExtensionHostClient) {
      await clientClose.call(this);
      order.push("client");
      throw new Error("peer-close-failed");
    },
  );
  const storeClose = SqliteRunStore.prototype.close;
  context.mock.method(
    SqliteRunStore.prototype,
    "close",
    async function (this: SqliteRunStore) {
      await storeClose.call(this);
      order.push("store");
    },
  );
  await assert.rejects(runtime.app.close(), /peer-close-failed/u);
  assert.deepEqual(order, ["client", "store"]);
});

test(
  "PostgreSQL creator retains default plugin absence and explicitly opts into shared migration and configuration",
  {
    skip: process.env.CREWON_TEST_POSTGRES_URL === undefined,
  },
  async (context) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const suffix = randomUUID().replaceAll("-", "");
    const schemas = [
      `extension_default_${suffix}`,
      `extension_optin_${suffix}`,
    ];
    const admin = new Pool({ connectionString, max: 1 });
    const apps: FastifyInstance[] = [];
    context.after(async () => {
      try {
        for (const app of apps) await app.close();
        for (const schema of schemas)
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    const worker = await workerFixture(context);
    const { databasePath: _, ...defaultConfig } = config(context);
    const ordinary = await createPostgresControlApi({
      ...defaultConfig,
      connectionString,
      schema: schemas[0],
    });
    apps.push(ordinary.app);
    assert.equal(
      (
        await ordinary.app.inject({
          method: "GET",
          url: `${base}/configuration`,
          headers: headers(),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'extension_%'",
          [schemas[0]],
        )
      ).rowCount,
      0,
    );
    const { databasePath: __, ...extensionConfig } = config(context);
    const enabled = await createPostgresControlApi({
      ...extensionConfig,
      connectionString,
      schema: schemas[1],
      extensionWorker: worker,
    });
    apps.push(enabled.app);
    const saved = await enabled.app.inject({
      method: "PUT",
      url: `${base}/configuration`,
      headers: headers(),
      payload: saveBody,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().configuration.tenantId, actor.tenantId);
    assert.equal(
      enabled.app.hasRoute({
        method: "POST",
        url: "/api/v1/extensions/:pluginId/tasks",
      }),
      true,
    );
    const result = await admin.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'extension_%'",
      [schemas[1]],
    );
    assert.ok(
      result.rows.some(
        ({ table_name }) => table_name === "extension_configurations",
      ),
    );
    assert.ok(
      result.rows.some(
        ({ table_name }) => table_name === "extension_external_operations",
      ),
    );
  },
);
