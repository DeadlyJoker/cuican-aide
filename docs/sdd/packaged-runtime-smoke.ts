/** Isolated CLI check of the installed app's runtime bundles; no user data or model calls. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  RuntimeSupervisor,
  runtimePaths,
} from "../../apps/crewon-ui/electron/runtimeSupervisor.ts";
import { ControlApiClient } from "../../packages/control-client/src/index.ts";

const resourcesPath = resolve(process.argv[2]);
const fixtures = resolve(process.argv[3]);
const evidencePath = resolve(process.argv[4]);
const dataDirectory = mkdtempSync(join(tmpdir(), "crewon-installed-runtime-"));
Object.defineProperty(process, "resourcesPath", {
  value: resourcesPath,
  configurable: true,
});
const paths = runtimePaths({
  packaged: true,
  repositoryRoot: "/unused",
  resourcesPath,
});
const runtime = new RuntimeSupervisor({
  dataDirectory,
  paths,
  repositoryRoot: null,
  provider: () => ({
    providerId: "packaged-smoke",
    endpoint: "http://127.0.0.1:9/v1",
    modelId: "packaged-smoke",
    apiKey: "synthetic-unused-key-00000000000000000000",
  }),
  providerModelCatalog: async () => ["packaged-smoke"],
  agentPlatformApiKeyForOrigin: () => null,
});
function client() {
  const session = runtime.session();
  return new ControlApiClient({
    ...session,
    accessToken: session.sessionToken,
  });
}
try {
  await runtime.start();
  let api = client();
  const health = await fetch(
    new URL("api/v1/health/ready", runtime.session().baseUrl),
  );
  assert.equal(health.status, 200);
  const offices = await api.listOffices();
  assert.ok(Array.isArray(offices.data));
  const agents = await api.getActiveAgentVersionCatalog();
  assert.ok(agents);
  const { thread } = await api.createThread(
    { title: "Installed DMG runtime smoke" },
    "dmg-smoke-thread",
  );
  const ids: string[] = [];
  for (const name of ["orders-a.csv", "orders-b.csv", "orders-template.xlsx"]) {
    const template = name.endsWith(".xlsx");
    const input = await api.delivery.upload(
      thread.threadId,
      {
        name,
        role: template ? "template" : "data",
        mediaType: template
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv",
        contentBase64: readFileSync(join(fixtures, name)).toString("base64"),
      },
      `dmg-smoke-${name}`,
    );
    ids.push(input.inputId);
  }
  const request = JSON.parse(
    readFileSync(join(fixtures, "orders-request.json"), "utf8"),
  );
  request.templateInputId = ids[2];
  request.sources[0].inputId = ids[0];
  request.sources[1].inputId = ids[1];
  const version = await api.delivery.assemble(
    thread.threadId,
    request,
    "dmg-smoke-assemble",
  );
  assert.equal(version.validation.writtenRows, 5);
  assert.equal(
    version.validation.sources.reduce(
      (sum, row) => sum + (row.exceptionRows ?? 0),
      0,
    ),
    1,
  );
  const original = await api.delivery.download(
    thread.threadId,
    { kind: "version", id: version.versionId },
    version,
  );
  assert.equal(
    `sha256:${createHash("sha256").update(original).digest("hex")}`,
    version.contentDigest,
  );
  await runtime.restart();
  api = client();
  const restored = await api.delivery.catalog(thread.threadId);
  assert.equal(restored.inputs.length, 3);
  assert.equal(restored.deliveries.length, 1);
  const recovered = await api.delivery.download(
    thread.threadId,
    { kind: "version", id: version.versionId },
    version,
  );
  assert.deepEqual(recovered, original);
  const replay = await api.delivery.assemble(
    thread.threadId,
    request,
    "dmg-smoke-assemble",
  );
  assert.equal(replay.versionId, version.versionId);
  writeFileSync(join(dataDirectory, "installed-app-output.xlsx"), original);
  const evidence = {
    schemaVersion: "crewon.packaged-runtime-smoke.v1",
    executable: process.execPath,
    node: process.versions.node,
    electron: process.versions.electron,
    resourcesPath,
    dataDirectory,
    runtimeSource: paths.source,
    healthStatus: health.status,
    teamCatalogReadable: true,
    activeAgentCatalogReadable: true,
    threadId: thread.threadId,
    versionId: version.versionId,
    bytes: original.length,
    contentDigest: version.contentDigest,
    writtenRows: version.validation.writtenRows,
    sourceChecks: version.validation.sources,
    restartBytesIdentical: true,
    idempotentReplaySameVersion: true,
    modelCalls: 0,
    accountLoginTested: false,
    userDataUsed: false,
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    JSON.stringify({
      result: "passed",
      bytes: original.length,
      writtenRows: 5,
      restartBytesIdentical: true,
      evidencePath,
    }),
  );
} finally {
  await runtime.stop();
}
