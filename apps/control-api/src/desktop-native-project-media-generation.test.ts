import assert from "node:assert/strict";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  FilesystemArtifactStore,
  loadArtifactEncryptionKey,
} from "@crewon/artifacts";
import { loadDesktopProjectMaterialArchive } from "@crewon/media-runtime/desktop-project-material-archive";
import { desktopNativeMediaInputFixture } from "./desktop-native-project-media-input.test-support.ts";
import { isInstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";
import { assertInstalledPluginTaskRuntimeCoreBinding } from "./installed-plugin-task-runtime-core.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { parseInstalledPluginPeerRequest } from "@crewon/contracts/plugins";
import { loadNativeProjectMediaReviews } from "../../runtime-worker/src/plugins/native-project-media-reviews.ts";
import { assertDesktopNativePluginControlConfigCurrent } from "./desktop-native-plugin-control-environment.ts";

const options = { skip: process.platform === "win32", timeout: 30_000 };
type Fixture = Awaited<ReturnType<typeof desktopNativeMediaInputFixture>>;
function request(f: Fixture) {
  return {
    method: "POST" as const,
    url: `/api/v1/creative-projects/${f.query.projectId}/media-generations`,
    headers: { ...f.headers, "idempotency-key": "native-media-generation" },
    payload: {
      mediaInputId: f.query.mediaInputId,
      inputRevision: 1,
      expectedInputRevision: 1,
      executionId: "native-media-execution",
      threadId: "native-unbound-thread",
      expectedThreadRevision: 1,
    },
  };
}
function counts(f: Fixture) {
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    return [
      "run_snapshots",
      "work_items",
      "project_media_generation_links",
    ].map((name) => db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()!.n);
  } finally {
    db.close();
  }
}

test(
  "Native generation opt-in constructs the genuine original Core owner and HTTP route; metadata alone grants neither",
  options,
  async (t) => {
    for (const mediaGenerations of [false, true]) {
      const f = await desktopNativeMediaInputFixture(t, ["read", "write"], {
        mediaGenerations,
      });
      assert.equal(
        isInstalledProjectMediaGenerationRuntime(
          f.runtime.projectMediaGenerations,
        ),
        mediaGenerations,
      );
      assert.equal(
        Object.hasOwn(f.startup.creativeProjects!, "mediaGenerations"),
        false,
      );
      assertInstalledPluginTaskRuntimeCoreBinding(f.runtime.tasks!, {
        store: f.parent,
        requests: f.runtime.configuration.requests,
      });
      assert.equal(
        f.app.hasRoute({
          method: "POST",
          url: "/api/v1/creative-projects/:projectId/media-generations",
        }),
        mediaGenerations,
      );
      assert.equal(
        f.app.hasRoute({
          method: "GET",
          url: "/api/v1/creative-projects/:projectId/threads/:threadId/media-generation-recovery",
        }),
        mediaGenerations,
      );
      assert.deepEqual(f.peer, []);
      assert.equal(f.routeState.wakes, 0);
      if (mediaGenerations) {
        assert.equal(
          f.bootstrap.schemaVersion,
          "crewon.desktop-plugin-bootstrap.v3",
        );
        assert.ok(
          f.bootstrap.schemaVersion === "crewon.desktop-plugin-bootstrap.v3",
        );
        const reviews = await loadNativeProjectMediaReviews({
          projects: f.bootstrap.projects,
          authority: f.nativeControl.authority,
          current: () =>
            assertDesktopNativePluginControlConfigCurrent(f.nativeControl),
        });
        assert.deepEqual(
          reviews?.map(({ targetIdentity, workflow }) => ({
            targetIdentity,
            workflow,
          })),
          f.mediaInputs.reviews,
        );
        assert.deepEqual(counts(f), [0, 0, 0]);
      } else assert.equal((await f.app.inject(request(f))).statusCode, 404);
    }
  },
);

test(
  "Native generation authenticates the original identity/CSRF and rejects absent project-thread binding without a Run",
  options,
  async (t) => {
    const f = await desktopNativeMediaInputFixture(t, ["read", "write"], {
      mediaGenerations: true,
    });
    const req = request(f),
      before = counts(f);
    for (const [headers, expected] of [
      [{ ...req.headers, authorization: "Bearer wrong" }, 401],
      [{ ...req.headers, "x-csrf-token": "wrong" }, 403],
    ] as const) {
      const response = await f.app.inject({ ...req, headers });
      assert.equal(response.statusCode, expected, response.body);
    }
    assert.deepEqual(f.peer, []);
    const forged = await f.app.inject({
      ...req,
      payload: { ...req.payload, profileId: f.scope.profileId },
    });
    assert.equal(forged.statusCode, 400, forged.body);
    const unbound = await f.app.inject(req);
    assert.equal(unbound.statusCode, 403, unbound.body);
    assert.deepEqual(counts(f), before);
    assert.equal(f.routeState.wakes, 0);
    assert.ok(f.peer.every((p) => p === "catalog"));
  },
);

test(
  "Native material owner retires without closing its borrowed parent; cold reopen shares the same scoped archive",
  options,
  async (t) => {
    const f = await desktopNativeMediaInputFixture(t, ["read", "write"], {
      mediaGenerations: true,
    });
    const owner = f.runtime.projectMediaGenerations!;
    const archive = loadDesktopProjectMaterialArchive(f.storage, f.scope);
    archive.encryptionKey.fill(0);
    const first = await stat(archive.rootDirectory);
    await f.runtime.close();
    await f.runtime.close();
    assert.ok(
      await f.parent.creativeProjectStore().loadProject({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: f.query.projectId,
      }),
    );
    const req = request(f);
    assert.throws(() =>
      owner.generate({ ...f.request(), url: req.url }, f.actor, {
        ...req.payload,
        projectId: f.query.projectId,
        idempotencyKey: "after-close",
      }),
    );
    await f.app.close();
    const next = await f.reopen();
    assert.ok(
      isInstalledProjectMediaGenerationRuntime(
        next.runtime.projectMediaGenerations,
      ),
    );
    assert.notEqual(next.runtime.projectMediaGenerations, owner);
    assert.notEqual(next.parent, f.parent);
    const reopened = await stat(archive.rootDirectory);
    assert.equal(reopened.ino, first.ino);
    assert.equal(reopened.dev, first.dev);
    const metadata = await next.app.inject({
      method: "GET",
      url: `${next.request().url}/${f.query.mediaInputId}`,
      headers: next.headers,
    });
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.deepEqual(f.peer, []);
  },
);

test(
  "Native generation loses authority when the exact-byte approval or Main owner is withdrawn",
  options,
  async (t) => {
    for (const change of ["approval", "withdrawal"] as const) {
      const f = await desktopNativeMediaInputFixture(t, ["read", "write"], {
        mediaGenerations: true,
      });
      if (change === "approval") {
        const bytes = await readFile(f.approvalPath);
        await rename(f.approvalPath, `${f.approvalPath}.old`);
        await writeFile(f.approvalPath, bytes, { mode: 0o600 });
      } else
        await writeFile(
          join(dirname(f.authorityPath), "withdrawn.json"),
          "{}",
          { mode: 0o600 },
        );
      const response = await f.app.inject(request(f));
      assert.notEqual(response.statusCode, 200);
      assert.deepEqual(counts(f), [0, 0, 0]);
      assert.equal(f.routeState.wakes, 0);
      assert.deepEqual(f.peer, []);
    }
  },
);

test(
  "Native media generation startup fails closed on missing or invalid host archive storage",
  options,
  async (t) => {
    for (const materialStorageFixture of ["missing", "invalid-key"] as const)
      await assert.rejects(
        desktopNativeMediaInputFixture(t, ["read", "write"], {
          mediaGenerations: true,
          materialStorageFixture,
        }),
        materialStorageFixture === "missing"
          ? /desktop_native_project_material_storage_required/u
          : /artifact_key_file_invalid/u,
      );
  },
);

test(
  "original standalone Native composition publishes generation through buildControlApi and keeps project metadata usable",
  options,
  async (t) => {
    let current: Fixture | undefined;
    const operations: string[] = [];
    const peer = createServer(async (req, res) => {
      try {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/private/v1/installed-plugins");
        assert.ok(current);
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const request = parseInstalledPluginPeerRequest(
          JSON.parse(Buffer.concat(parts).toString("utf8")),
        );
        assert.equal(request.operation, "catalog");
        assert.deepEqual(request.actor, current.actor);
        assert.deepEqual(request.scope, current.scope);
        operations.push(request.operation);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            protocol: "crewon.installed-plugin-peer-response.v1",
            requestId: request.requestId,
            operation: request.operation,
            actor: current.actor,
            scope: current.scope,
            entries: [current.peerCatalog],
          }),
        );
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      peer.once("error", reject);
      peer.listen(0, "127.0.0.1", resolve);
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          peer.closeAllConnections();
          peer.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const f = await desktopNativeMediaInputFixture(t, ["read", "write"], {
      mediaGenerations: true,
      peerOrigin: `http://127.0.0.1:${(peer.address() as AddressInfo).port}`,
    });
    current = f;
    await f.app.close();
    await f.runtime.close();
    await f.parent.close();
    const artifactStore = new FilesystemArtifactStore({
      rootDirectory: f.storage.artifactRoot,
      databasePath: join(dirname(f.databasePath), "artifacts.sqlite"),
      encryptionKey: loadArtifactEncryptionKey(f.storage.encryptionKeyPath),
      keyId: f.storage.encryptionKeyId,
    });
    let close = async () => artifactStore.close();
    try {
      const runtime = await createStandaloneControlApiWithPlugins({
        databasePath: f.databasePath,
        actor: f.actor,
        sessionToken: f.headers.authorization.slice("Bearer ".length),
        csrfToken: f.headers["x-csrf-token"],
        allowedOrigins: [f.headers.origin],
        defaultAgentVersionId: "named-native-main-agent",
        artifactStore,
        artifactEncryptionKeyId: f.storage.encryptionKeyId,
        desktopPlugins: f.bootstrap,
        desktopNativePluginControl: f.nativeControl,
        desktopProjectMaterialStorage: f.storage,
        ...f.startup,
        outboxScanIntervalMs: null,
        automationScanIntervalMs: null,
        heartbeatIntervalMs: null,
        artifactRetention: null,
      });
      close = () => runtime.app.close();
      assert.ok(
        runtime.app.hasRoute({
          method: "POST",
          url: "/api/v1/creative-projects/:projectId/media-generations",
        }),
      );
      const response = await runtime.app.inject(request(f));
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(operations, ["catalog"]);
      const metadata = await runtime.app.inject({
        method: "GET",
        url: `${f.request().url}/${f.query.mediaInputId}`,
        headers: f.headers,
      });
      assert.equal(metadata.statusCode, 200, metadata.body);
      assert.deepEqual(counts(f), [0, 0, 0]);
    } finally {
      await close();
    }
  },
);
