import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type {
  ArtifactRetentionGuard,
  PutArtifactInput,
} from "@crewon/application";
import { FilesystemArtifactStore } from "./filesystem-artifact-store.ts";
import { DEFAULT_ARTIFACT_RETENTION } from "./artifact-retention.ts";
import { artifactStagingPath } from "./artifact-blob-file.ts";

export function recoveryInput(id = "artifact"): PutArtifactInput {
  const content = Buffer.alloc(8192, 65);
  const now = Date.now();
  return {
    idempotencyKey: `tool-output-${id}`,
    content,
    record: {
      schemaVersion: "crewon.artifact.v0",
      artifactId: id,
      tenantId: "tenant",
      spaceId: "space",
      ownerActorId: "actor",
      kind: "toolOutput",
      mediaType: "text/plain",
      sensitivity: "workspaceSensitive",
      source: {
        kind: "toolOutput",
        runId: `run-${id}`,
        stepId: "step",
        attemptId: "attempt",
        callId: "call",
      },
      contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      byteLength: content.byteLength,
      retention: {
        kind: "run",
        expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
      },
      encryption: { scheme: "aes256gcm", keyId: "key" },
      scan: { status: "notRequired", scannedAt: null, scanner: null },
      createdAt: new Date(now).toISOString(),
    },
  };
}

export function recoveryFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "crewon-artifact-recovery-"));
  const databasePath = path.join(root, "artifacts.sqlite");
  const stores: FilesystemArtifactStore[] = [];
  const open = (key = 42) => {
    const store = new FilesystemArtifactStore({
      rootDirectory: root,
      databasePath,
      encryptionKey: Buffer.alloc(32, key),
      keyId: "key",
    });
    stores.push(store);
    return store;
  };
  const store = open();
  const database = new DatabaseSync(databasePath);
  t.after(async () => {
    database.close();
    for (const store of stores) await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const blob = (input: PutArtifactInput) => {
    const hash = createHash("sha256")
      .update(input.record.tenantId)
      .update("\0")
      .update(input.record.artifactId)
      .digest("hex");
    return path.join(
      root,
      "blobs",
      hash.slice(0, 2),
      hash.slice(2, 4),
      `${hash}.artifact`,
    );
  };
  const due = () =>
    database.exec(
      "UPDATE artifact_maintenance SET next_due_ms=0; UPDATE artifact_retention_queue SET next_check_ms=0",
    );
  const policy = {
    ...DEFAULT_ARTIFACT_RETENTION,
    minimumIntervalMs: 100,
    maxDurationMs: 5000,
  };
  return {
    root,
    databasePath,
    database,
    store,
    open,
    blob,
    due,
    policy,
    stage: (input: PutArtifactInput) => artifactStagingPath(blob(input)),
    maintain: (
      target = store,
      guard: ArtifactRetentionGuard = { canRetireArtifact: async () => false },
    ) =>
      target.retention.maintainArtifacts({
        policy,
        guard,
        signal: new AbortController().signal,
      }),
    crash(input: PutArtifactInput, mode: "staged" | "partial" | "ready") {
      const child = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          artifactWriterScript(mode),
        ],
        {
          env: writerEnvironment(root, databasePath, input),
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(child.status, 77, child.stderr);
    },
  };
}

export function writerEnvironment(
  root: string,
  databasePath: string,
  input: PutArtifactInput,
) {
  return {
    ...process.env,
    CREWON_ARTIFACT_RECOVERY_ROOT: root,
    CREWON_ARTIFACT_RECOVERY_DB: databasePath,
    CREWON_ARTIFACT_RECOVERY_INPUT: JSON.stringify({
      record: input.record,
      idempotencyKey: input.idempotencyKey,
      content: Buffer.from(input.content).toString("base64"),
    }),
  };
}

export function artifactWriterScript(
  mode: "staged" | "partial" | "ready" | "race",
) {
  return `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; import { DatabaseSync } from 'node:sqlite';
    import { FilesystemArtifactStore } from ${JSON.stringify(new URL("./filesystem-artifact-store.ts", import.meta.url).href)};
    const rename=fs.renameSync, write=fs.writeSync;
    ${mode === "staged" ? "fs.renameSync=(from,to)=>{if(String(from).endsWith('.staging-v1'))process.exit(77);return rename(from,to);};" : ""}
    ${mode === "partial" ? "fs.writeSync=(fd,buffer,offset,length,position)=>{write(fd,buffer,offset,Math.min(length,17),position);process.exit(77);};" : ""}
    ${mode === "race" ? "let paused=false;fs.writeSync=(...args)=>{if(!paused){paused=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}return write(...args);};" : ""}
    ${mode === "ready" ? "const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql),run=stmt.run.bind(stmt);stmt.run=(...args)=>{const result=run(...args);if(sql.startsWith(\"UPDATE artifacts SET state = 'ready'\"))process.exit(77);return result;};return stmt;};" : ""}
    syncBuiltinESMExports();
    const store=new FilesystemArtifactStore({rootDirectory:process.env.CREWON_ARTIFACT_RECOVERY_ROOT,databasePath:process.env.CREWON_ARTIFACT_RECOVERY_DB,encryptionKey:Buffer.alloc(32,42),keyId:'key'});
    const input=JSON.parse(process.env.CREWON_ARTIFACT_RECOVERY_INPUT);input.content=Buffer.from(input.content,'base64');
    ${mode === "race" ? "process.stdout.write('ready\\n');await new Promise(resolve=>process.stdin.once('data',resolve));" : ""}
    try {process.stdout.write(JSON.stringify(await store.put(input))+'\\n');} finally {await store.close();}`;
}
