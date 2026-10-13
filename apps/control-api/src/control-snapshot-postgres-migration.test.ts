import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  SqliteRunStore,
  PostgresDomainStore,
  PostgresPimActorBindings,
} from "@crewon/store";
import { ThreadApplicationService } from "@crewon/application";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
  StandaloneAuthorization,
} from "./standalone-adapters.ts";
import { migrateControlSnapshotToPostgres } from "./control-snapshot-postgres-migration.ts";

test(
  "migrates actual stored conversation/workspace records, keeps receipts replayable and rejects overwriting",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "crewon-snapshot-pg-")),
    );
    const path = join(directory, "source.sqlite");
    const schema = `snapshot_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 2,
    });
    const bindingSchema = `bindings_${randomUUID().replaceAll("-", "")}`;
    const source = new SqliteRunStore(path);
    let target: PostgresDomainStore | undefined;
    t.after(async () => {
      await source.close();
      await target?.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${bindingSchema}" CASCADE`);
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    });
    const actor = {
      tenantId: "legacy-tenant",
      spaceId: "legacy-space",
      actorId: "legacy-actor",
      principalId: "legacy-principal",
    };
    const dependencies = {
      authorization: new StandaloneAuthorization(actor),
      clock: new SystemApplicationClock(),
      ids: new UuidV7ApplicationIdGenerator(),
      digester: new NodeSha256ContentDigester(),
    };
    const threads = new ThreadApplicationService({
      ...dependencies,
      store: source,
    });
    const command = {
      kind: "thread.create" as const,
      title: "保留历史",
      workspaceId: "existing-workspace",
      idempotencyKey: "original-create",
    };
    const created = await threads.createThread(actor, command);
    await threads.appendMessage(actor, {
      kind: "thread.message.append",
      threadId: created.state.threadId,
      expectedRevision: created.state.revision,
      idempotencyKey: "original-message",
      role: "user",
      content: "保留正文和工作空间关联。",
    });
    // Close before hashing: this is a frozen backup, never a live WAL source.
    await source.close();
    await chmod(path, 0o600);
    target = await PostgresDomainStore.open({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      schema,
    });
    await target.workflowVersionStore(dependencies.digester).migrate();
    const hash = `sha256:${createHash("sha256")
      .update(await readFile(path))
      .digest("hex")}`;
    const input = {
      sourcePath: path,
      expectedSourceDigest: hash,
      pool,
      schema,
      signal: new AbortController().signal,
    };
    const report = await migrateControlSnapshotToPostgres(input);
    assert.equal(report.tables.find((x) => x.table === "threads")?.rows, 1);
    assert.equal(report.tables.find((x) => x.table === "messages")?.rows, 1);
    const bindings = new PostgresPimActorBindings({
      pool,
      schema: bindingSchema,
    });
    await bindings.migrate();
    const verifiedAccount = {
      userId: 12,
      tenantId: 6,
      spaceId: 7,
      userRole: "admin",
      spaceRole: "owner",
      expiresAt: Date.now() + 60000,
    };
    await bindings.adoptImportedLegacyActor({
      verifiedAccount,
      actor,
      coreSchema: schema,
      sourceDigest: hash,
    });
    assert.deepEqual(
      await bindings.resolveVerifiedAccountActor(verifiedAccount),
      actor,
    );
    const member = await bindings.resolveVerifiedAccountActor({
      ...verifiedAccount,
      userId: 13,
    });
    assert.equal(member.tenantId, actor.tenantId);
    assert.equal(member.spaceId, actor.spaceId);
    assert.notEqual(member.principalId, actor.principalId);
    const outside = await bindings.resolveVerifiedAccountActor({
      ...verifiedAccount,
      userId: 14,
      spaceId: 8,
    });
    assert.notEqual(outside.spaceId, actor.spaceId);
    await assert.rejects(
      bindings.adoptImportedLegacyActor({
        verifiedAccount,
        actor,
        coreSchema: schema,
        sourceDigest: hash,
      }),
    );
    await assert.rejects(
      pool.query(`UPDATE "${bindingSchema}".bindings SET actor_id='another'`),
      /binding_immutable/,
    );
    const migrated = new ThreadApplicationService({
      ...dependencies,
      store: target,
    });
    const replay = await migrated.createThread(actor, command);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.state.threadId, created.state.threadId);
    const state = await target.loadThread({
      tenantId: actor.tenantId,
      threadId: created.state.threadId,
    });
    assert.equal(state?.workspaceId, "existing-workspace");
    const messages = await target.listMessages(
      { tenantId: actor.tenantId, threadId: created.state.threadId },
      0,
      10,
    );
    assert.equal(messages[0]?.content, "保留正文和工作空间关联。");
    await assert.rejects(
      migrateControlSnapshotToPostgres(input),
      /target_not_empty/,
    );
    await assert.rejects(
      migrateControlSnapshotToPostgres({
        ...input,
        expectedSourceDigest: `sha256:${"0".repeat(64)}`,
      }),
      /source_changed/,
    );
    assert.equal(
      `sha256:${createHash("sha256")
        .update(await readFile(path))
        .digest("hex")}`,
      hash,
    );
  },
);
