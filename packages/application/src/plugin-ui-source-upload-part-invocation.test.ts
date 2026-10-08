import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSourceUploadMutationResponse } from "@crewon/contracts/project-source-uploads";
import { sourceUploadActionFixture } from "./plugin-project-source-upload-action.test-support.ts";
import { uploadSha } from "./project-source-upload.test-support.ts";
import { uiDeferred, uiTestActor } from "./plugin-ui.test-support.ts";
import { capturePluginProjectSourceUploadInvocation } from "./plugin-project-source-upload-invocation.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";

const small = new TextEncoder().encode("夜航 😀\n第一章：站台");
const metadata = (bytes: Uint8Array = small, key = "raw-begin") => ({
  idempotencyKey: key,
  fileName: "故事.txt",
  format: "txt" as const,
  byteLength: bytes.length,
  fileDigest: uploadSha(bytes),
});
type Fixture = Awaited<ReturnType<typeof sourceUploadActionFixture>>;
async function start(f: Fixture, bytes = small) {
  return (
    (await f.invoke(
      "begin",
      metadata(bytes),
    )) as ProjectSourceUploadMutationResponse
  ).upload.uploadId;
}
const locator = (uploadId: string, bytes = small, partIndex = 0) => ({
  uploadId,
  partIndex,
  rawDigest: uploadSha(bytes),
});
const raw = (
  f: Fixture,
  uploadId: string,
  bytes = small,
  partIndex = 0,
  signal?: AbortSignal,
) =>
  f.service.invokeProjectSourceUploadPart(
    uiTestActor,
    {
      mountRef: f.lease.mountRef,
      locator: locator(uploadId, bytes, partIndex),
    },
    bytes,
    signal === undefined ? undefined : { signal },
  );

test("dedicated mounted raw transport writes exact two parts, replays, then prepares without byte JSON", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const bytes = new Uint8Array(65_536 + small.length);
  bytes.fill(97, 0, 65_536);
  bytes.set(small, 65_536);
  const uploadId = await start(f, bytes);
  const first = await raw(f, uploadId, bytes.slice(0, 65_536));
  assert.equal(first.disposition, "committed");
  assert.equal(first.upload.revision, 2);
  assert.deepEqual(first.upload.receivedParts, [
    {
      index: 0,
      byteLength: 65_536,
      rawDigest: uploadSha(bytes.slice(0, 65_536)),
    },
  ]);
  const replay = await raw(f, uploadId, bytes.slice(0, 65_536));
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.upload.revision, 2);
  const second = await raw(f, uploadId, small, 1);
  assert.equal(second.upload.revision, 3);
  assert.equal(second.upload.receivedParts.length, 2);
  assert.deepEqual(
    f.uploads.store.payloads.get(uploadId)!.get(0),
    bytes.slice(0, 65_536),
  );
  assert.deepEqual(f.uploads.store.payloads.get(uploadId)!.get(1), small);
  assert.equal(
    (
      (await f.invoke("prepare", { uploadId, expectedRevision: 3 })) as {
        disposition: string;
      }
    ).disposition,
    "ready",
  );
  for (const field of [
    "owner",
    "storageRealmId",
    "claim",
    "chunks",
    "bytes",
    "sealed",
    "initial",
  ])
    assert.equal(Object.hasOwn(second.upload, field), false, field);
  assert.throws(() =>
    capturePluginProjectSourceUploadInvocation(f.state.partContext!),
  );
});

test("raw read and write retain independent write pin and PDP, with no status permission", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f);
  f.uploads.flags.permissionActions.length = 0;
  f.uploads.flags.denyAction = "projectSourceUpload:status";
  let pin: string | undefined;
  f.uploads.store.before = async (method) => {
    if (method === "writePart")
      pin = capturePluginProjectSourceUploadInvocation(f.state.partContext!)
        .authority.transaction!.pin.action;
  };
  await raw(f, uploadId);
  assert.equal(pin, "crewon.project-source-uploads.v1.writePart");
  assert.ok(f.uploads.flags.permissionActions.length > 0);
  assert.ok(
    f.uploads.flags.permissionActions.every(
      (action) => action === "projectSourceUpload:write",
    ),
  );
  await assert.rejects(f.invoke("status", { uploadId }));
});

test("raw entry and explicit host part authorization are unavailable by default", async (t) => {
  for (const options of [{}, { raw: true, authorizePart: false }]) {
    const f = await sourceUploadActionFixture(options);
    t.after(() => f.owner.close());
    const uploadId = await start(f);
    await assert.rejects(raw(f, uploadId));
    assert.equal(f.uploads.store.states.get(uploadId)!.revision, 1);
    assert.equal(f.uploads.store.payloads.get(uploadId)!.size, 0);
  }
});

test("raw native bytes are detached before the first asynchronous policy fence", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f),
    gate = uiDeferred(),
    entered = uiDeferred();
  const caller = new Uint8Array(small);
  f.ui.state.beforeAuthorize = async (action) => {
    if (action === "invoke") {
      entered.resolve();
      await gate.promise;
    }
  };
  const pending = raw(f, uploadId, caller);
  await entered.promise;
  caller.fill(0);
  gate.resolve();
  assert.equal((await pending).disposition, "committed");
  assert.deepEqual(f.uploads.store.payloads.get(uploadId)!.get(0), small);
});

test("locator/options accessors and malformed or non-native byte payloads reject before writes", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f);
  let getters = 0;
  const hostile = Object.defineProperty({}, "uploadId", {
    enumerable: true,
    get() {
      getters++;
      return uploadId;
    },
  });
  const badSignal = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      getters++;
      return new AbortController().signal;
    },
  });
  await assert.rejects(
    f.service.invokeProjectSourceUploadPart(
      uiTestActor,
      { mountRef: f.lease.mountRef, locator: hostile as never },
      small,
    ),
  );
  await assert.rejects(
    f.service.invokeProjectSourceUploadPart(
      uiTestActor,
      { mountRef: f.lease.mountRef, locator: locator(uploadId) },
      small,
      badSignal,
    ),
  );
  for (const bytes of [
    new Uint8Array(0),
    new Uint8Array(65_537),
    Array.from(small),
    { byteLength: small.length },
  ])
    await assert.rejects(
      f.service.invokeProjectSourceUploadPart(
        uiTestActor,
        { mountRef: f.lease.mountRef, locator: locator(uploadId) },
        bytes as Uint8Array,
      ),
    );
  await assert.rejects(raw(f, uploadId, new Uint8Array([1])));
  const changed = new Uint8Array(small);
  changed[0] ^= 1;
  await assert.rejects(
    f.service.invokeProjectSourceUploadPart(
      uiTestActor,
      { mountRef: f.lease.mountRef, locator: locator(uploadId) },
      changed,
    ),
    { code: "project_source_upload_part_digest_mismatch" },
  );
  await assert.rejects(raw(f, uploadId, small, 1));
  await assert.rejects(
    f.service.invokeProjectSourceUploadPart(
      uiTestActor,
      { mountRef: f.lease.mountRef, locator: locator(uploadId) },
      small,
      { signal: {} as AbortSignal },
    ),
  );
  assert.equal(getters, 0);
  assert.equal(f.uploads.store.payloads.get(uploadId)!.size, 0);
});

test("JSON invoke cannot register a raw pin or smuggle bytes through a prepare grant", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f);
  await assert.rejects(
    f.service.invoke(uiTestActor, {
      mountRef: f.lease.mountRef,
      action: "crewon.project-source-uploads.v1.writePart",
      input: locator(uploadId),
    }),
  );
  await assert.rejects(
    f.invoke("prepare", {
      uploadId,
      expectedRevision: 1,
      bytes: Array.from(small),
    }),
  );
  assert.equal(f.uploads.store.payloads.get(uploadId)!.size, 0);
});

test("host part policy, business write policy and real mount actor are independently required", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f);
  f.state.partAllowed = false;
  await assert.rejects(raw(f, uploadId));
  f.state.partAllowed = true;
  f.uploads.flags.denyAction = "projectSourceUpload:write";
  await assert.rejects(raw(f, uploadId));
  f.uploads.flags.denyAction = null;
  await assert.rejects(
    f.service.invokeProjectSourceUploadPart(
      { ...uiTestActor, actorId: "other-agent" },
      { mountRef: f.lease.mountRef, locator: locator(uploadId) },
      small,
    ),
  );
  assert.equal(f.uploads.store.payloads.get(uploadId)!.size, 0);
});

test("abort before invocation and before durable write prevents raw state changes", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f),
    already = new AbortController();
  let signalHooks = 0;
  Object.defineProperties(already.signal, {
    aborted: {
      get() {
        signalHooks++;
        return false;
      },
    },
    throwIfAborted: {
      value() {
        signalHooks++;
      },
    },
  });
  already.abort();
  await assert.rejects(raw(f, uploadId, small, 0, already.signal));
  assert.equal(signalHooks, 0);
  const during = new AbortController();
  f.uploads.store.before = async (method) => {
    if (method === "writePart") during.abort();
  };
  await assert.rejects(raw(f, uploadId, small, 0, during.signal));
  assert.equal(f.uploads.store.states.get(uploadId)!.revision, 1);
  assert.equal(f.uploads.store.payloads.get(uploadId)!.size, 0);
});

test("actual confirmed raw commit survives subsequent abort, close and PDP withdrawal", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f),
    controller = new AbortController();
  f.uploads.store.afterCommit = () => {
    controller.abort();
    f.uploads.flags.active = false;
    void f.owner.close();
    void f.service.closeMount(uiTestActor, { mountRef: f.lease.mountRef });
  };
  const result = await raw(f, uploadId, small, 0, controller.signal);
  assert.equal(result.disposition, "committed");
  assert.equal(result.upload.revision, 2);
  assert.deepEqual(f.uploads.store.payloads.get(uploadId)!.get(0), small);
});

test("closing the owner while raw policy is pending withdraws its write and joins cleanup", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const uploadId = await start(f),
    gate = uiDeferred(),
    entered = uiDeferred();
  f.state.beforePart = async () => {
    entered.resolve();
    await gate.promise;
  };
  const pending = raw(f, uploadId);
  await entered.promise;
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  assert.equal(closed, false);
  gate.resolve();
  await assert.rejects(pending);
  await closing;
  assert.equal(closed, true);
  assert.equal(f.uploads.store.payloads.get(uploadId)!.size, 0);
});

test("raw service construction refuses forged owner and accessor configuration", async () => {
  const getter = Object.defineProperty({}, "sourceUploads", {
    get() {
      throw new Error("must_not_execute");
    },
  });
  assert.throws(() => new PluginUiApplicationService(getter as never), {
    code: "plugin_project_source_upload_owner_invalid",
  });
  assert.throws(
    () => new PluginUiApplicationService({ sourceUploads: {} } as never),
    { code: "plugin_project_source_upload_owner_invalid" },
  );
});

test("a real head CAS race is explicit and the identical retry uses the new head", async (t) => {
  const f = await sourceUploadActionFixture({ raw: true });
  t.after(() => f.owner.close());
  const bytes = new Uint8Array(65_536 + small.length);
  bytes.fill(97, 0, 65_536);
  bytes.set(small, 65_536);
  const uploadId = await start(f, bytes),
    first = bytes.slice(0, 65_536);
  f.uploads.store.before = async (method) => {
    if (method !== "writePart") return;
    f.uploads.store.before = null;
    await f.uploads.service.writePart(uiTestActor, {
      uploadId,
      expectedRevision: 1,
      index: 1,
      byteOffset: 65_536,
      rawDigest: uploadSha(small),
      bytes: small,
    });
  };
  await assert.rejects(raw(f, uploadId, first), {
    code: "project_source_upload_revision_conflict",
  });
  assert.equal(f.uploads.store.states.get(uploadId)!.revision, 2);
  assert.equal(f.uploads.store.payloads.get(uploadId)!.has(0), false);
  assert.equal((await raw(f, uploadId, first)).upload.revision, 3);
  assert.deepEqual(f.uploads.store.payloads.get(uploadId)!.get(0), first);
});
