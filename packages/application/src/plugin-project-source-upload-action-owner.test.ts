import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS as actions,
  type ProjectSourceUploadMutationResponse,
  type ProjectSourceUploadPreparationResponse,
  type PublicProjectSourceUpload,
} from "@crewon/contracts/project-source-uploads";
import {
  PluginProjectSourceUploadActionOwner,
  isPluginProjectSourceUploadActionOwner,
} from "./plugin-project-source-upload-action-owner.ts";
import {
  ProjectSourceUploadApplicationService,
  isProjectSourceUploadApplicationService,
} from "./project-source-upload-application-service.ts";
import {
  capturePluginProjectSourceUploadInvocation,
  registerPluginProjectSourceUploadRawInvocation,
} from "./plugin-project-source-upload-invocation.ts";
import { captureSourceUploadAuthority } from "./project-source-upload-validation.ts";
import { captureProjectSourceUploadExecutionAuthority } from "./project-source-upload-plugin-commit-authority.ts";
import { sourceUploadActionFixture } from "./plugin-project-source-upload-action.test-support.ts";
import { uploadSha } from "./project-source-upload.test-support.ts";
import {
  uiDeferred,
  uiTestActor,
  uiTestDigest,
} from "./plugin-ui.test-support.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import * as api from "./index.ts";

const bytes = new TextEncoder().encode("夜雨中，两个人在车站重逢。😀");
const begin = {
  idempotencyKey: "begin-1",
  fileName: "故事.txt",
  format: "txt" as const,
  byteLength: bytes.length,
  fileDigest: uploadSha(bytes),
};
const mutation = (input: unknown) =>
  input as ProjectSourceUploadMutationResponse;
const prepared = (input: unknown) =>
  input as ProjectSourceUploadPreparationResponse;
const visible = (input: unknown) =>
  (input as { upload: PublicProjectSourceUpload }).upload;

test("upload owner and genuine Service are branded while invocation issuance/capture stay private", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  assert.equal(
    api.PluginProjectSourceUploadActionOwner,
    PluginProjectSourceUploadActionOwner,
  );
  assert.equal(isPluginProjectSourceUploadActionOwner(f.owner), true);
  assert.equal(
    isProjectSourceUploadApplicationService(f.uploads.service),
    true,
  );
  assert.equal(
    isProjectSourceUploadApplicationService(
      Object.create(ProjectSourceUploadApplicationService.prototype),
    ),
    false,
  );
  assert.equal(
    isPluginProjectSourceUploadActionOwner(
      Object.create(PluginProjectSourceUploadActionOwner.prototype),
    ),
    false,
  );
  for (const key of [
    "registerPluginProjectSourceUploadInvocation",
    "registerPluginProjectSourceUploadRawInvocation",
    "capturePluginProjectSourceUploadInvocation",
    "registerPluginUiInvocation",
  ])
    assert.equal(Object.hasOwn(api, key), false, key);
  assert.throws(
    () =>
      new PluginProjectSourceUploadActionOwner({
        uploads: Object.create(ProjectSourceUploadApplicationService.prototype),
        publications: [
          {
            pluginId: "example.story",
            packageDigest: uiTestDigest,
            contributionId: "workbench",
          },
        ],
        authorization: { authorize: async () => {} },
      }),
  );
});

test("the genuine mounted four-action flow returns only bounded upload projection", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  for (const action of Object.values(actions))
    assert.equal(f.owner.supportsAction(action), true);
  assert.equal(
    f.owner.supportsAction("crewon.project-source-uploads.v1.writePart"),
    false,
  );
  const started = mutation(await f.invoke("begin", begin));
  assert.equal(started.disposition, "committed");
  const uploadId = started.upload.uploadId;
  assert.deepEqual(
    visible(await f.invoke("status", { uploadId })),
    started.upload,
  );
  const replay = mutation(await f.invoke("begin", begin));
  assert.equal(replay.disposition, "replayed");
  // Explicit trusted internal byte port in this Application fixture. No public raw HTTP route is claimed.
  const raw = await f.uploads.service.writePart(uiTestActor, {
    uploadId,
    expectedRevision: 1,
    index: 0,
    byteOffset: 0,
    rawDigest: uploadSha(bytes),
    bytes,
  });
  const ready = prepared(
    await f.invoke("prepare", {
      uploadId,
      expectedRevision: raw.state.revision,
    }),
  );
  assert.equal(ready.disposition, "ready");
  assert.equal(ready.upload.phase, "ready");
  assert.equal(
    ready.upload.prepared!.digest,
    uploadSha(new TextDecoder().decode(bytes)),
  );
  for (const key of [
    "owner",
    "initial",
    "claim",
    "sealed",
    "storageRealmId",
    "normalizationParserVersion",
    "provenance",
    "chunks",
    "chapters",
    "text",
  ])
    assert.equal(key in ready.upload, false, key);
  for (const key of [
    "pointer",
    "preparedAt",
    "normalizationParserVersion",
    "chunkManifestDigest",
  ])
    assert.equal(key in ready.upload.prepared!, false, key);
  const second = mutation(
    await f.invoke("begin", { ...begin, idempotencyKey: "begin-2" }),
  );
  const cancelled = mutation(
    await f.invoke("cancel", {
      uploadId: second.upload.uploadId,
      expectedRevision: 1,
    }),
  );
  assert.equal(cancelled.upload.phase, "cancelled");
  assert.equal(
    mutation(
      await f.invoke("cancel", {
        uploadId: second.upload.uploadId,
        expectedRevision: 99,
      }),
    ).disposition,
    "replayed",
  );
});

test("copied, invented or ended contexts cannot issue an upload authority", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  let calls = 0;
  const hostile = Object.defineProperty({}, "action", {
    get() {
      calls++;
      return actions.begin;
    },
  }) as PluginUiActionContext;
  await assert.rejects(f.owner.actions.invoke(hostile));
  assert.equal(calls, 0);
  await f.invoke("begin", begin);
  const ended = f.state.context!;
  assert.throws(() => capturePluginProjectSourceUploadInvocation(ended));
  assert.throws(() => capturePluginProjectSourceUploadInvocation({ ...ended }));
  await assert.rejects(f.owner.actions.invoke(ended));
  assert.throws(() =>
    registerPluginProjectSourceUploadRawInvocation(ended, async () => {}),
  );
});

test("actual live upload authority detaches the independent pin and cannot be used for a raw write", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  let captured:
    | ReturnType<typeof capturePluginProjectSourceUploadInvocation>
    | undefined;
  f.uploads.store.before = async (method) => {
    if (method === "begin")
      captured = capturePluginProjectSourceUploadInvocation(f.state.context!);
  };
  await f.invoke("begin", begin);
  const authority = captured!.authority;
  assert.equal(
    authority.transaction!.version,
    "crewon.project-source-upload-plugin-commit.v1",
  );
  assert.equal(authority.transaction!.pin.action, actions.begin);
  assert.equal(Object.isFrozen(authority.transaction!.package), true);
  assert.throws(() => authority.assertActive());
  assert.throws(() =>
    captureSourceUploadAuthority({
      version: "crewon.project-source-upload-commit.v1",
      permission: {
        actor: uiTestActor,
        action: "projectSourceUpload:write",
        resource: {
          kind: "projectSourceUpload",
          owner: {
            tenantId: uiTestActor.tenantId,
            spaceId: uiTestActor.spaceId,
            principalId: uiTestActor.principalId,
          },
          uploadId: "upload-1",
          projectId: null,
        },
      },
      assertCurrent: async () => {},
      assertActive() {},
      transaction: authority.transaction,
    }),
  );
});

test("host publication and business PDP are independent and checked before upload creation", async (t) => {
  const wrong = await sourceUploadActionFixture({
    publicationDigest: `sha256:${"b".repeat(64)}`,
  });
  t.after(() => wrong.owner.close());
  await assert.rejects(wrong.invoke("begin", begin));
  assert.equal(wrong.uploads.flags.ids, 0);
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  f.state.hostAllowed = false;
  await assert.rejects(f.invoke("begin", begin));
  assert.equal(f.uploads.flags.ids, 0);
  f.state.hostAllowed = true;
  f.uploads.flags.denyAction = "projectSourceUpload:begin";
  await assert.rejects(f.invoke("begin", begin));
  assert.equal(f.uploads.flags.ids, 0);
  assert.equal(f.uploads.store.states.size, 0);
});

test("withdrawal before metadata commit rejects without publishing a false receipt", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  f.uploads.store.before = async (method) => {
    if (method === "begin") f.ui.state.allowed.delete("invoke");
  };
  await assert.rejects(f.invoke("begin", begin));
  assert.equal(f.uploads.store.states.size, 0);
  assert.equal(f.state.raw, undefined);
});

test("a real committed upload reply survives later UI, PDP and owner withdrawal", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  f.uploads.store.afterCommit = () => {
    f.ui.state.allowed.clear();
    f.uploads.flags.active = false;
    void f.owner.close();
  };
  const result = mutation(await f.invoke("begin", begin));
  assert.equal(result.disposition, "committed");
  assert.equal(f.uploads.store.states.size, 1);
  assert.equal(f.owner.committedMetadata.isOutcome(f.state.raw), false);
  assert.throws(() =>
    f.owner.committedMetadata.verify(f.state.context!, f.state.raw as never),
  );
  await assert.rejects(f.invoke("begin", begin));
});

test("status remains a live read and cannot use the committed metadata bypass", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  const started = mutation(await f.invoke("begin", begin));
  f.state.afterAction = () => {
    f.ui.state.allowed.delete("invoke");
  };
  await assert.rejects(
    f.invoke("status", { uploadId: started.upload.uploadId }),
  );
  assert.equal(f.uploads.store.states.size, 1);
  assert.equal(f.owner.committedMetadata.isOutcome(f.state.raw), false);
});

test("closing upload owner withdraws synchronously then joins its in-flight request", async () => {
  const f = await sourceUploadActionFixture(),
    entered = uiDeferred(),
    resume = uiDeferred();
  f.uploads.store.before = async (method) => {
    if (method === "begin") {
      entered.resolve();
      await resume.promise;
    }
  };
  const pending = f.invoke("begin", begin);
  void pending.catch(() => {});
  await entered.promise;
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  assert.equal(closed, false);
  assert.throws(() => f.owner.assertAvailable());
  resume.resolve();
  await assert.rejects(pending);
  await closing;
  assert.equal(closed, true);
  assert.equal(f.uploads.store.states.size, 0);
});

test("raw byte and foreign scope fields are rejected at the original JSON invocation", async (t) => {
  const f = await sourceUploadActionFixture();
  t.after(() => f.owner.close());
  for (const field of [
    "bytes",
    "base64",
    "owner",
    "tenantId",
    "prepared",
    "claim",
    "sourceUpload",
  ])
    await assert.rejects(f.invoke("begin", { ...begin, [field]: "private" }));
  assert.equal(f.uploads.flags.ids, 0);
  assert.equal(f.uploads.store.states.size, 0);
});

test("strict authority capture does not execute getters and rejects an old transaction namespace", () => {
  let calls = 0;
  const hostile = Object.defineProperty({}, "authority", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => captureProjectSourceUploadExecutionAuthority(hostile));
  assert.equal(calls, 0);
  assert.throws(() =>
    captureProjectSourceUploadExecutionAuthority({
      authority: {
        assertCurrent: async () => {},
        assertActive() {},
        transaction: { version: "crewon.project-foundation-plugin-commit.v1" },
      },
    } as never),
  );
});
