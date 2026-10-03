import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import {
  ControlApiClient,
  ControlApiClientError,
} from "../../packages/control-client/src/index.ts";

const readyPath = new URL(
  "../../output/extensions/checks/installed-short-drama-preview-ready.json",
  import.meta.url,
);
const logPath = new URL(
  "../../output/extensions/checks/installed-short-drama-preview-http-20261003.json",
  import.meta.url,
);
const ready = JSON.parse(await readFile(readyPath, "utf8")) as {
  state: string;
  previewUrl: string;
  controlUrl: string;
};
assert.equal(ready.state, "ready");
const origin = new URL(ready.previewUrl).origin;
const deadline = AbortSignal.timeout(15_000);
const response = await fetch(new URL("/control-api/session", origin), {
  signal: deadline,
});
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
const session = (await response.json()) as {
  baseUrl: string;
  csrfToken: string;
};
assert.deepEqual(Object.keys(session).sort(), ["baseUrl", "csrfToken"]);
assert.equal(session.baseUrl, "/");
assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
const client = new ControlApiClient({
  baseUrl: new URL(session.baseUrl, origin).toString(),
  origin,
  csrfToken: session.csrfToken,
});
const catalog = await client.plugins.uiCatalog({}, { signal: deadline });
assert.equal(catalog.plugins.length, 1);
const entry = catalog.plugins[0]!;
assert.equal(entry.descriptor.pluginId, "crewon.short-drama");
assert.equal(entry.descriptor.entrypoints.node, null);
assert.equal(entry.descriptor.entrypoints.ui?.mode, "trustedModule");
const request = {
  pluginId: entry.descriptor.pluginId,
  contributionId: "workbench",
  expectedSelectionRevision: entry.selectionRevision,
  expectedPackageDigest: entry.packageDigest,
};
const missingCsrf = await fetch(new URL("/api/v1/plugins/ui/mounts", origin), {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify(request),
  signal: deadline,
});
assert.equal(missingCsrf.status, 403);
assert.equal(
  ((await missingCsrf.json()) as { error: { code: string } }).error.code,
  "csrf_invalid",
);
const wrongCsrf = await fetch(new URL("/api/v1/plugins/ui/mounts", origin), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin,
    "x-csrf-token": "invalid-fixture-csrf",
  },
  body: JSON.stringify(request),
  signal: deadline,
});
assert.equal(wrongCsrf.status, 403);
await wrongCsrf.body?.cancel();
const foreignOrigin = await fetch(
  new URL("/api/v1/plugins/ui/catalog", origin),
  { headers: { origin: "https://foreign.invalid" }, signal: deadline },
);
assert.equal(foreignOrigin.status, 403);
await foreignOrigin.body?.cancel();
const crossSite = await fetch(new URL("/control-api/session", origin), {
  headers: { "sec-fetch-site": "cross-site" },
  signal: deadline,
});
assert.equal(crossSite.status, 403);
await crossSite.body?.cancel();
const foreignHostStatus = await new Promise<number>((resolve, reject) => {
  const request = httpRequest(
    new URL("/control-api/session", origin),
    {
      headers: { host: "foreign.invalid" },
      signal: deadline,
    },
    (response) => {
      response.resume();
      resolve(response.statusCode!);
    },
  );
  request.on("error", reject);
  request.end();
});
assert.equal(foreignHostStatus, 403);
const unauthenticatedControl = await fetch(
  new URL("/api/v1/plugins/ui/catalog", ready.controlUrl),
  { headers: { origin }, signal: deadline },
);
assert.equal(unauthenticatedControl.status, 401);
await unauthenticatedControl.body?.cancel();
const lease = await client.plugins.openMount(request, { signal: deadline });
const assets: Array<{
  path: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
}> = [];
try {
  const validated = await client.plugins.validateMount(lease.mountRef, {
    signal: deadline,
  });
  assert.equal(validated.packageDigest, lease.packageDigest);
  for (const path of lease.publicAssets) {
    // Native ESM and PNG requests do not carry a renderer Bearer or an Origin header.
    const asset = await fetch(
      new URL(
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/${path}`,
        origin,
      ),
      { signal: deadline },
    );
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "no-store");
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    const bytes = new Uint8Array(await asset.arrayBuffer());
    const expected = lease.descriptor.files.find((file) => file.path === path)!;
    assert.equal(bytes.byteLength, expected.byteLength);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, expected.sha256);
    assets.push({
      path,
      bytes: bytes.byteLength,
      sha256: digest,
      contentType: asset.headers.get("content-type"),
    });
  }
  assert.equal(assets.length, 2);
  const nativeImport = await fetch(
    new URL(
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui.mjs?import`,
      origin,
    ),
    { signal: deadline },
  );
  assert.equal(nativeImport.status, 200);
  const nativeBytes = new Uint8Array(await nativeImport.arrayBuffer());
  assert.equal(
    createHash("sha256").update(nativeBytes).digest("hex"),
    lease.descriptor.files.find((file) => file.path === "ui.mjs")!.sha256,
  );
  for (const query of ["?import=value", "?other", "?import&other"]) {
    const invalidQuery = await fetch(
      new URL(
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui.mjs${query}`,
        origin,
      ),
      { signal: deadline },
    );
    assert.equal(invalidQuery.status, 400);
    await invalidQuery.body?.cancel();
  }
  const privateAsset = await fetch(
    new URL(
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/SDK-LICENSE`,
      origin,
    ),
    { signal: deadline },
  );
  assert.equal(privateAsset.status, 404);
  await privateAsset.body?.cancel();
  await assert.rejects(
    client.plugins.invoke(
      lease.mountRef,
      { action: "image.generate", input: {} },
      { signal: deadline },
    ),
    (error: unknown) =>
      error instanceof ControlApiClientError && error.status === 403,
  );
} finally {
  await client.plugins.closeMount(lease.mountRef);
}
await assert.rejects(
  client.plugins.validateMount(lease.mountRef),
  (error: unknown) =>
    error instanceof ControlApiClientError && error.status === 404,
);
assert.equal((await client.plugins.closeMount(lease.mountRef)).closed, true);
const proofResponse = await fetch(
  new URL("/__installed-short-drama-proof", origin),
  { signal: deadline },
);
assert.equal(proofResponse.status, 200);
const proof = (await proofResponse.json()) as Record<string, unknown>;
for (const key of ["runs", "threads", "messages", "creditTables"])
  assert.equal(proof[key], 0);
assert.equal(proof.installedPackages, 1);
assert.equal(proof.selectionReceipts, 2);
const log = {
  scope:
    "actual installed SQLite + production UI HTTP routes; no browser execution asserted",
  bootstrap: {
    exactPublicKeys: ["baseUrl", "csrfToken"],
    bearerExposed: false,
    cacheControl: "no-store",
  },
  catalogCount: catalog.plugins.length,
  actualMountOpenedValidatedClosed: true,
  idempotentClose: true,
  boundaries: {
    missingCsrf: 403,
    wrongCsrf: 403,
    foreignOrigin: 403,
    crossSiteBootstrap: 403,
    foreignHost: 403,
    privateControlUnauthenticated: 401,
    privateAsset: 404,
    invokeDenied: 403,
    closedMount: 404,
    viteEmptyImportMarker: 200,
    nonemptyOrAdditionalAssetQueries: 400,
  },
  assets,
  proof,
};
await writeFile(logPath, JSON.stringify(log, null, 2) + "\n");
console.log(JSON.stringify(log, null, 2));
