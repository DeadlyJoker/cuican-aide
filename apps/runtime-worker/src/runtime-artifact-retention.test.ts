import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ArtifactApplicationService,
  ArtifactStoreError,
} from "@crewon/application";
import {
  DEFAULT_ARTIFACT_RETENTION,
  FilesystemArtifactStore,
} from "@crewon/artifacts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import { artifactStagingPath } from "../../../packages/artifacts/src/artifact-blob-file.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: actual Tool artifact retirement preserves canonical history and the next model continuation`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (t) => {
      const directory = mkdtempSync(
        join(tmpdir(), "crewon-runtime-artifact-retention-"),
      );
      const storage = new FilesystemArtifactStore({
        rootDirectory: directory,
        databasePath: join(directory, "artifacts.sqlite"),
        encryptionKey: Buffer.alloc(32, 42),
        keyId: "key",
      });
      t.after(async () => {
        await storage.close();
        rmSync(directory, { recursive: true, force: true });
      });
      let nextId = 0;
      const service = new ArtifactApplicationService({
        store: storage,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => `artifact-${++nextId}` },
        digester: {
          sha256: (value) =>
            `sha256:${createHash("sha256").update(value).digest("hex")}`,
        },
        encryptionKeyId: "key",
        retentionMs: 60000,
      });
      const fixture = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        output: "result ".repeat(20000),
        artifacts: service,
      });
      const outcome = await fixture.worker().wake();
      assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
      const receipt = (await fixture.receipts())[0]!;
      assert.ok(receipt?.result?.artifactRef);
      const record = await storage.get({
        tenantId: receipt.tenantId,
        artifactId: receipt.result.artifactRef,
      });
      assert.ok(record);
      const candidate = { record, idempotencyKey: receipt.idempotencyKey };
      assert.equal(await fixture.canRetireArtifact(candidate), true);
      if (backend === "sqlite") {
        assert.equal(await fixture.encodedToolResultCount(), 1);
        const restore = await fixture.breakEncodedToolResult();
        try {
          await assert.rejects(fixture.canRetireArtifact(candidate), {
            code: "stored_tool_receipt_invalid",
          });
        } finally {
          await restore();
        }
        assert.equal(await fixture.canRetireArtifact(candidate), true);
      }

      const history = await fixture.history(),
        events = await fixture.events(),
        calls = structuredClone(fixture.requests);
      t.mock.timers.enable({
        apis: ["Date"],
        now:
          Date.parse(record.retention.expiresAt) +
          DEFAULT_ARTIFACT_RETENTION.recoveryGraceMs +
          1,
      });
      const result = await storage.retention.maintainArtifacts({
        policy: { ...DEFAULT_ARTIFACT_RETENTION, maxDurationMs: 5000 },
        guard: fixture,
        signal: new AbortController().signal,
      });
      assert.equal(result.deleted, 1);
      assert.equal(result.deletedBytes, record.byteLength);
      assert.equal(
        readdirSync(join(directory, "blobs"), { recursive: true }).filter(
          (name) => String(name).endsWith(".artifact"),
        ).length,
        0,
      );
      assert.deepEqual(await fixture.history(), history);
      assert.deepEqual(await fixture.events(), events);
      assert.deepEqual(fixture.requests, calls);
      assert.deepEqual(await storage.get(record), record);
      assert.equal(await storage.read(record), null);
      await fixture.reopen();
      await fixture.nextUserTurn();
      assert.equal((await fixture.worker().wake()).kind, "completed");
      assert.equal(fixture.requests.length, calls.length + 1);
      assert.equal(
        typeof fixture.requests.at(-1)?.previous_response_id,
        "string",
      );
      assert.equal(
        fixture.executions(),
        1,
        "retirement must not repeat the external Tool effect",
      );
    },
  );

for (const backend of ["sqlite", "postgres"] as const)
  for (const location of ["staging", "final"] as const)
    test(
      `${backend}: ${location} artifact recovery leaves the pending Tool's model prefix unchanged and resumes without repeating its effect`,
      {
        skip:
          backend === "postgres" &&
          process.env.CREWON_TEST_POSTGRES_URL === undefined,
      },
      async (t) => {
        const directory = mkdtempSync(
          join(tmpdir(), "crewon-runtime-artifact-recovery-"),
        );
        const databasePath = join(directory, "artifacts.sqlite");
        const storage = new FilesystemArtifactStore({
          rootDirectory: directory,
          databasePath,
          encryptionKey: Buffer.alloc(32, 42),
          keyId: "key",
        });
        const database = new DatabaseSync(databasePath);
        t.after(async () => {
          database.close();
          await storage.close();
          rmSync(directory, { recursive: true, force: true });
        });
        let interrupt = true,
          ids = 0;
        const service = new ArtifactApplicationService({
          store: {
            async put(input) {
              const result = await storage.put(input);
              if (interrupt) {
                interrupt = false;
                const row = database
                  .prepare(
                    "SELECT relative_path FROM artifacts WHERE tenant_id=? AND artifact_id=?",
                  )
                  .get(result.record.tenantId, result.record.artifactId)!;
                const filename = join(
                  directory,
                  "blobs",
                  String(row.relative_path),
                );
                if (location === "staging")
                  renameSync(filename, artifactStagingPath(filename));
                database
                  .prepare(
                    "UPDATE artifacts SET state='writing' WHERE tenant_id=? AND artifact_id=?",
                  )
                  .run(result.record.tenantId, result.record.artifactId);
                throw new ArtifactStoreError("fixture_after_staging");
              }
              return result;
            },
            get: (input) => storage.get(input),
            read: (input) => storage.read(input),
            close: () => storage.close(),
          },
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          clock: { now: () => new Date().toISOString() },
          ids: { nextId: () => `recovered-artifact-${++ids}` },
          digester: {
            sha256: (value) =>
              `sha256:${createHash("sha256").update(value).digest("hex")}`,
          },
          encryptionKeyId: "key",
          retentionMs: 60_000,
        });
        const fixture = await createFixture(t, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          output: "result ".repeat(20000),
          artifacts: service,
        });
        assert.equal((await fixture.worker().wake()).kind, "retried");
        assert.equal(fixture.executions(), 1);
        assert.equal(fixture.requests.length, 1);
        const history = await fixture.history(),
          events = await fixture.events(),
          requests = structuredClone(fixture.requests),
          usage = await fixture.usageRecords();
        const result = await storage.retention.maintainArtifacts({
          policy: { ...DEFAULT_ARTIFACT_RETENTION, maxDurationMs: 5000 },
          guard: fixture,
          signal: new AbortController().signal,
        });
        assert.equal(result.recovered, 1);
        assert.equal(result.deleted, 0);
        assert.deepEqual(await fixture.history(), history);
        assert.deepEqual(await fixture.events(), events);
        assert.deepEqual(await fixture.usageRecords(), usage);
        assert.deepEqual(fixture.requests, requests);
        await fixture.reopen();
        await fixture.makeDue();
        const completed = await fixture.worker().wake();
        assert.equal(completed.kind, "completed", JSON.stringify(completed));
        assert.equal(fixture.executions(), 1);
        assert.equal(fixture.requests.length, 2);
        assert.equal(fixture.requests[1]!.previous_response_id, "resp-tools");
        assert.equal(
          database.prepare("SELECT count(*) AS n FROM artifacts").get()!.n,
          1,
        );
        const receipt = (await fixture.receipts())[0]!;
        assert.ok(receipt.result?.artifactRef);
        const output = await storage.read({
          tenantId: receipt.tenantId,
          artifactId: receipt.result.artifactRef,
        });
        assert.ok(output);
        assert.equal(
          new TextDecoder().decode(output.content),
          "result ".repeat(20000),
        );
      },
    );
