import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import { ProjectSourceUploadApplicationService } from "./project-source-upload-application-service.ts";
import {
  beginAndWrite,
  sourceUploadFixture,
  uploadActor,
  uploadSha,
  simpleParsed,
} from "./project-source-upload.test-support.ts";
const errorCode = (code: string) => (e: unknown) =>
  e instanceof ApplicationError && e.code === code;

test("begin receipts precede host IDs; same principal UI/Agent replays, changed original key conflicts", async () => {
  const f = sourceUploadFixture(),
    bytes = new TextEncoder().encode("原文"),
    command = {
      idempotencyKey: "begin-book",
      fileName: "book.txt",
      format: "txt" as const,
      byteLength: bytes.length,
      fileDigest: uploadSha(bytes),
    };
  const first = await f.service.begin(uploadActor, command);
  const agent = await f.service.begin(
    { ...uploadActor, actorId: "agent" },
    command,
  );
  assert.equal(agent.disposition, "replayed");
  assert.deepEqual(agent.state, first.state);
  assert.equal(f.flags.ids, 1);
  assert.equal(f.store.calls.filter((c) => c === "begin").length, 1);
  await assert.rejects(
    f.service.begin(uploadActor, { ...command, fileName: "other.txt" }),
    errorCode("project_source_upload_idempotency_conflict"),
  );
  assert.equal(f.flags.ids, 1);
});

test("byte snapshot happens before any asynchronous policy/read; retry replays only original bytes", async () => {
  const f = sourceUploadFixture(),
    bytes = new TextEncoder().encode("original"),
    original = bytes.slice(),
    command = {
      idempotencyKey: "snapshot",
      fileName: "book.txt",
      format: "txt" as const,
      byteLength: bytes.length,
      fileDigest: uploadSha(bytes),
    };
  const start = await f.service.begin(uploadActor, command),
    write = {
      uploadId: start.state.initial.uploadId,
      expectedRevision: 1,
      index: 0,
      byteOffset: 0,
      rawDigest: uploadSha(original),
      bytes,
    };
  const pending = f.service.writePart(uploadActor, write);
  bytes.fill(88);
  const first = await pending;
  assert.deepEqual(f.store.payloads.get(write.uploadId)!.get(0), original);
  assert.equal(first.state.revision, 2);
  assert.equal(
    (await f.service.writePart(uploadActor, { ...write, bytes: original }))
      .disposition,
    "replayed",
  );
  await assert.rejects(
    f.service.writePart(uploadActor, {
      ...write,
      bytes,
      rawDigest: uploadSha(bytes),
    }),
    errorCode("project_source_upload_part_conflict"),
  );
  assert.equal(f.store.states.get(write.uploadId)!.revision, 2);
});

test("bounds raw data and full-file metadata without a parser, model or project dispatch", async () => {
  const f = sourceUploadFixture(),
    small = new TextEncoder().encode("small");
  await assert.rejects(
    f.service.begin(uploadActor, {
      idempotencyKey: "large",
      fileName: "book.txt",
      format: "txt",
      byteLength: 20_000_001,
      fileDigest: uploadSha(small),
    }),
  );
  assert.equal(f.flags.ids, 0);
  assert.deepEqual(f.store.calls, []);
  const start = await f.service.begin(uploadActor, {
    idempotencyKey: "missing",
    fileName: "book.txt",
    format: "txt",
    byteLength: 65_537,
    fileDigest: uploadSha(small),
  });
  await assert.rejects(
    f.service.writePart(uploadActor, {
      uploadId: start.state.initial.uploadId,
      expectedRevision: 1,
      index: 0,
      byteOffset: 0,
      rawDigest: uploadSha(small),
      bytes: new Uint8Array(65_537),
    }),
    errorCode("project_source_upload_bytes_invalid"),
  );
  await assert.rejects(
    f.service.prepare(uploadActor, {
      uploadId: start.state.initial.uploadId,
      expectedRevision: 1,
    }),
    errorCode("project_source_upload_parts_missing"),
  );
  assert.equal(f.flags.parses, 0);
  assert.equal(f.flags.claims, 0);
});

test("real 20 MB actual bytes traverse 306 bounded raw parts then only the injected parser", async () => {
  const f = sourceUploadFixture(),
    bytes = new Uint8Array(20_000_000).fill(65),
    { state } = await beginAndWrite(f, bytes);
  assert.equal(state.parts.length, 306);
  assert.equal(state.parts.at(-1)!.byteLength, 11_520);
  assert.ok(state.parts.every((p) => p.byteLength <= 65_536));
  let observed = 0;
  f.flags.parser = async (input) => {
    observed = input.bytes.length;
    assert.equal(uploadSha(input.bytes), uploadSha(bytes));
    return simpleParsed(input);
  };
  const result = await f.service.prepare(uploadActor, {
    uploadId: state.initial.uploadId,
    expectedRevision: state.revision,
  });
  assert.equal(result.disposition, "ready");
  assert.equal(observed, 20_000_000);
  assert.equal(result.state.prepared!.normalizedByteLength, 20_000_000);
  assert.equal(result.state.prepared!.characterLength, 20_000_000);
  assert.equal(f.flags.parses, 1);
});

test("an interrupted parser claim stays recoverable; live retry does not allocate or parse again", async () => {
  const f = sourceUploadFixture(),
    { state } = await beginAndWrite(f);
  f.flags.parser = async () => {
    throw new Error("parser_process_interrupted");
  };
  await assert.rejects(
    f.service.prepare(uploadActor, {
      uploadId: state.initial.uploadId,
      expectedRevision: state.revision,
    }),
    /parser_process_interrupted/,
  );
  let current = f.store.states.get(state.initial.uploadId)!;
  assert.equal(current.phase, "preparing");
  assert.equal(f.flags.claims, 1);
  const pending = await f.service.prepare(uploadActor, {
    uploadId: state.initial.uploadId,
    expectedRevision: current.revision,
  });
  assert.equal(pending.disposition, "pending");
  assert.equal(f.flags.claims, 1);
  assert.equal(f.flags.parses, 1);
  f.flags.now = "2026-10-08T00:00:31.000Z";
  f.flags.parser = null;
  current = f.store.states.get(state.initial.uploadId)!;
  const resumed = await f.service.prepare(uploadActor, {
    uploadId: state.initial.uploadId,
    expectedRevision: current.revision,
  });
  assert.equal(resumed.disposition, "ready");
  assert.equal(f.flags.claims, 2);
  assert.equal(f.flags.parses, 2);
  assert.equal(f.flags.ids, 1);
});

test("known content rejection is durable; normalized UTF-8 expansion is not silently truncated", async () => {
  const f = sourceUploadFixture(),
    { state } = await beginAndWrite(f);
  f.flags.parser = async () => {
    const error = new Error("normalized limit");
    Object.defineProperty(error, "code", {
      value: "project_source_import_text_limit",
    });
    throw error;
  };
  const rejected = await f.service.prepare(uploadActor, {
    uploadId: state.initial.uploadId,
    expectedRevision: state.revision,
  });
  assert.equal(rejected.disposition, "rejected");
  assert.equal(rejected.state.failureCode, "project_source_import_text_limit");
  assert.equal(f.store.calls.includes("completePreparation"), false);
  assert.equal(
    (
      await f.service.prepare(uploadActor, {
        uploadId: state.initial.uploadId,
        expectedRevision: 1,
      })
    ).disposition,
    "rejected",
  );
  assert.equal(f.flags.parses, 1);
});

test("caller cancellation after parsing began leaves a recoverable claim rather than rejected content", async () => {
  const f = sourceUploadFixture(),
    { state } = await beginAndWrite(f),
    controller = new AbortController();
  f.flags.parser = async (input) => {
    controller.abort(new Error("caller-stopped"));
    return simpleParsed(input);
  };
  await assert.rejects(
    f.service.prepare(
      uploadActor,
      { uploadId: state.initial.uploadId, expectedRevision: state.revision },
      { signal: controller.signal },
    ),
    /caller-stopped/,
  );
  assert.equal(f.store.states.get(state.initial.uploadId)!.phase, "preparing");
  assert.equal(f.store.calls.includes("rejectPreparation"), false);
  assert.equal(f.store.calls.includes("completePreparation"), false);
});

test("prepared data keeps real ledger provenance and is reusable across projects/actors", async () => {
  const f = sourceUploadFixture(),
    { state, command } = await beginAndWrite(f);
  const ready = await f.service.prepare(uploadActor, {
    uploadId: state.initial.uploadId,
    expectedRevision: state.revision,
  });
  const first = await f.service.getPreparedForAdoption(uploadActor, {
    uploadId: state.initial.uploadId,
    fileDigest: command.fileDigest,
    projectId: "project-one",
  });
  const second = await f.service.getPreparedForAdoption(
    { ...uploadActor, actorId: "agent" },
    {
      uploadId: state.initial.uploadId,
      fileDigest: command.fileDigest,
      projectId: "project-two",
    },
  );
  assert.deepEqual(second, first);
  assert.deepEqual(first.provenance, ready.state.prepared!.pointer);
  assert.notEqual(first.digest, first.fileDigest);
  assert.ok(Object.isFrozen(first.chunks));
  assert.equal(f.flags.parses, 1);
  assert.equal(f.store.states.get(state.initial.uploadId)!.phase, "ready");
  assert.equal("consumed" in ready.state, false);
  f.store.payloads.delete(state.initial.uploadId);
  assert.deepEqual(
    await f.service.getPreparedForAdoption(uploadActor, {
      uploadId: state.initial.uploadId,
      fileDigest: command.fileDigest,
      projectId: "project-three",
    }),
    first,
  );
});

test("status ownership and independent adoption PDP cannot be forged or inferred from ready", async () => {
  const f = sourceUploadFixture(),
    { state, command } = await beginAndWrite(f);
  await f.service.prepare(uploadActor, {
    uploadId: state.initial.uploadId,
    expectedRevision: state.revision,
  });
  await assert.rejects(
    f.service.getStatus(
      { ...uploadActor, principalId: "other" },
      { uploadId: state.initial.uploadId },
    ),
    errorCode("project_source_upload_not_found"),
  );
  assert.equal(
    (
      await f.service.getStatus(uploadActor, {
        uploadId: state.initial.uploadId,
      })
    ).phase,
    "ready",
  );
  f.flags.denyAction = "projectSourceUpload:adopt";
  await assert.rejects(
    f.service.getPreparedForAdoption(uploadActor, {
      uploadId: state.initial.uploadId,
      fileDigest: command.fileDigest,
      projectId: null,
    }),
    errorCode("project_source_upload_permission_denied"),
  );
  assert.equal(f.store.calls.includes("loadPrepared"), false);
});

test("policy withdrawn before ready commit blocks it; withdrawal after confirmed commit returns facts", async () => {
  const f = sourceUploadFixture(),
    { state } = await beginAndWrite(f);
  f.flags.parser = async (input) => {
    f.flags.active = false;
    return simpleParsed(input);
  };
  await assert.rejects(
    f.service.prepare(uploadActor, {
      uploadId: state.initial.uploadId,
      expectedRevision: state.revision,
    }),
    errorCode("project_source_upload_permission_denied"),
  );
  assert.equal(f.store.states.get(state.initial.uploadId)!.phase, "preparing");
  assert.equal(f.store.calls.includes("completePreparation"), false);
  const g = sourceUploadFixture(),
    written = await beginAndWrite(g);
  g.store.before = async (method) => {
    if (method === "completePreparation")
      g.store.afterCommit = () => {
        g.flags.active = false;
      };
  };
  const committed = await g.service.prepare(uploadActor, {
    uploadId: written.state.initial.uploadId,
    expectedRevision: written.state.revision,
  });
  assert.equal(committed.disposition, "ready");
  assert.equal(g.flags.active, false);
});

test("tampered parser metadata/canonical digest fails closed and leaves the original claim", async () => {
  const f = sourceUploadFixture(),
    { state } = await beginAndWrite(f);
  f.flags.parser = async (input) => ({
    ...simpleParsed(input),
    fileDigest: uploadSha("forged"),
  });
  await assert.rejects(
    f.service.prepare(uploadActor, {
      uploadId: state.initial.uploadId,
      expectedRevision: state.revision,
    }),
    errorCode("project_source_upload_digest_mismatch"),
  );
  assert.equal(f.store.states.get(state.initial.uploadId)!.phase, "preparing");
  assert.equal(f.store.calls.includes("completePreparation"), false);
});

test("cancel is scoped, explicit and idempotent; ready source cannot be cancelled/consumed", async () => {
  const f = sourceUploadFixture(),
    { state } = await beginAndWrite(f),
    command = {
      uploadId: state.initial.uploadId,
      expectedRevision: state.revision,
    };
  assert.equal(
    (await f.service.cancel(uploadActor, command)).state.phase,
    "cancelled",
  );
  assert.equal(
    (await f.service.cancel(uploadActor, command)).disposition,
    "replayed",
  );
  await assert.rejects(
    f.service.prepare(uploadActor, command),
    errorCode("project_source_upload_terminal"),
  );
  assert.equal(f.flags.parses, 0);
  const g = sourceUploadFixture(),
    ready = await beginAndWrite(g);
  const result = await g.service.prepare(uploadActor, {
    uploadId: ready.state.initial.uploadId,
    expectedRevision: ready.state.revision,
  });
  await assert.rejects(
    g.service.cancel(uploadActor, {
      uploadId: ready.state.initial.uploadId,
      expectedRevision: result.state.revision,
    }),
    errorCode("project_source_upload_phase_conflict"),
  );
});

test("a BytePort which returns caller-owned bytes or an async active callback is not accepted", async () => {
  const f = sourceUploadFixture(),
    { state, bytes } = await beginAndWrite(f);
  const broken = new ProjectSourceUploadApplicationService({
    ...f.dependencies,
    bytes: {
      ...f.dependencies.bytes,
      capture(input) {
        return input as Uint8Array;
      },
    },
  });
  await assert.rejects(
    broken.writePart(uploadActor, {
      uploadId: state.initial.uploadId,
      expectedRevision: 1,
      index: 0,
      byteOffset: 0,
      rawDigest: uploadSha(bytes),
      bytes,
    }),
    errorCode("project_source_upload_bytes_invalid"),
  );
  const g = sourceUploadFixture();
  const bad = new ProjectSourceUploadApplicationService({
    ...g.dependencies,
    authorization: {
      ...g.dependencies.authorization,
      assertActive: () => Promise.resolve(),
    },
  });
  await assert.rejects(
    bad.begin(uploadActor, {
      idempotencyKey: "bad-authority",
      fileName: "book.txt",
      format: "txt",
      byteLength: 1,
      fileDigest: uploadSha("a"),
    }),
    errorCode("project_source_upload_authority_invalid"),
  );
  assert.equal(g.flags.ids, 0);
});
