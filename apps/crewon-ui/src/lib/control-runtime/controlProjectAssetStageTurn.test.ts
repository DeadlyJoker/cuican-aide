import { expect, it, vi } from "vitest";
import { ControlProjectAssetStageTurn } from "./controlProjectAssetStageTurn";
import {
  api,
  binding,
  selection,
  input,
  acknowledgement,
  deferred,
} from "./controlProjectAssetStage.test-support";
it("unknown retries preserve original body/key and revisions while current brief changes", async () => {
  const selected = { ...input, modelId: "gpt-5.6-sol" };
  const bodies: unknown[] = [];
  const key = vi.fn(() => "original-key");
  const fetch = vi.fn(
    async (_u: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      if (bodies.length === 1) throw new TypeError("lost ACK");
      return Response.json({ ...acknowledgement, disposition: "replayed" });
    },
  );
  const owner = new ControlProjectAssetStageTurn(api(fetch), key);
  await expect(owner.start(selected)).rejects.toThrow("lost ACK");
  await expect(
    owner.start({
      ...selected,
      expectedThreadRevision: 4,
      selection: {
        binding: { ...binding, revision: 2 },
        stage: { ...input.selection.stage, briefRevision: 2 },
      },
    }),
  ).resolves.toEqual({ threadId: "thread", runId: "actual-run" });
  expect(() => owner.start({ ...selected, modelId: "gpt-5.6-luna" })).toThrow(
    "original_request_pending",
  );
  expect(bodies[0]).toMatchObject({ modelId: selected.modelId });
  expect(bodies[0]).toEqual(bodies[1]);
  expect(key).toHaveBeenCalledTimes(1);
  expect(owner.retainedSelection("thread")).toEqual(input.selection);
  owner.adopted("thread", "different-run");
  expect(owner.retainedSelection("thread")).not.toBeNull();
  owner.adopted("thread", "actual-run");
  expect(owner.retainedSelection("thread")).toBeNull();
  await owner.close();
});
it("duplicate hot sends share actual transport and accepted restoration does not POST again", async () => {
  const gate = deferred<Response>(),
    fetch = vi.fn(() => gate.promise),
    owner = new ControlProjectAssetStageTurn(api(fetch), () => "key");
  const first = owner.start(input),
    second = owner.start(input);
  expect(second).toBe(first);
  gate.resolve(Response.json(acknowledgement));
  await first;
  await owner.start(input);
  expect(fetch).toHaveBeenCalledTimes(1);
  await owner.close();
});
it("unknown original input cannot move to another package, binding, project or asset source", async () => {
  const fetch = vi.fn(async () => {
      throw new TypeError("unknown");
    }),
    owner = new ControlProjectAssetStageTurn(api(fetch), () => "key");
  await expect(owner.start(input)).rejects.toThrow("unknown");
  for (const changed of [
    { ...binding, projectId: "other" },
    { ...binding, bindingId: "other" },
    { ...binding, workspaceId: "other" },
    { ...binding, source: { ...binding.source, selectionRevision: 3 } },
    {
      ...binding,
      source: { ...binding.source, packageDigest: `sha256:${"b".repeat(64)}` },
    },
  ])
    expect(() =>
      owner.start({
        ...input,
        selection: { ...input.selection, binding: changed },
      }),
    ).toThrow("original_request_pending");
  expect(() =>
    owner.start({
      ...input,
      selection: {
        ...input.selection,
        stage: { ...input.selection.stage, assetKind: "scene" },
      },
    }),
  ).toThrow("original_request_pending");
  expect(() =>
    owner.start({
      ...input,
      selection: {
        ...input.selection,
        stage: {
          ...input.selection.stage,
          script: {
            artifactId: "script",
            episodeId: "episode",
            contentRevision: 1,
          },
        },
      },
    }),
  ).toThrow("original_request_pending");
  expect(fetch).toHaveBeenCalledTimes(1);
  await owner.close();
});
it("withdraw aborts immediately but close waits for real late transport join", async () => {
  const gate = deferred<Response>();
  let signal: AbortSignal | undefined;
  const owner = new ControlProjectAssetStageTurn(
    api(async (_u, init) => {
      signal = init?.signal ?? undefined;
      return gate.promise;
    }),
    () => "key",
  );
  const pending = owner.start(input);
  const rejected = expect(pending).rejects.toBeDefined();
  let joined = false;
  const close = owner.close();
  expect(owner.close()).toBe(close);
  void close.then(() => (joined = true));
  expect(signal?.aborted).toBe(true);
  await Promise.resolve();
  expect(joined).toBe(false);
  gate.resolve(Response.json(acknowledgement));
  await rejected;
  await close;
  expect(joined).toBe(true);
  expect(owner.retainedSelection("thread")).toBeNull();
  expect(() => owner.start(input)).toThrow();
});
it("known CAS rejection clears original intent; unconfigured/authorization failure cannot silently rebase", async () => {
  let code = "project_conversation_revision_conflict";
  const keys = vi.fn().mockReturnValueOnce("key1").mockReturnValue("key2");
  const owner = new ControlProjectAssetStageTurn(
    api(async () =>
      Response.json(
        {
          error: {
            category: "conflict",
            code,
            message: "fixture",
            requestId: "fixture",
          },
        },
        { status: 409 },
      ),
    ),
    keys,
  );
  await expect(owner.start(input)).rejects.toBeDefined();
  expect(owner.retainedSelection("thread")).toBeNull();
  code = "project_asset_stage_unavailable";
  await expect(owner.start(input)).rejects.toBeDefined();
  expect(owner.retainedSelection("thread")).toEqual(input.selection);
  await expect(
    owner.start({ ...input, expectedThreadRevision: 4 }),
  ).rejects.toBeDefined();
  expect(keys).toHaveBeenCalledTimes(2);
  await owner.close();
});
it("a later binding CAS conflict cannot prove an earlier unknown intent uncommitted or mint a new key", async () => {
  const key = vi.fn(() => "original-key"),
    bodies: unknown[] = [];
  const owner = new ControlProjectAssetStageTurn(
    api(async (_u, init) => {
      bodies.push(JSON.parse(init!.body as string));
      if (bodies.length === 1) throw new TypeError("lost ACK");
      return Response.json(
        {
          error: {
            category: "conflict",
            code: "project_conversation_revision_conflict",
            requestId: "fixture",
          },
        },
        { status: 409 },
      );
    }),
    key,
  );
  await expect(owner.start(input)).rejects.toThrow("lost ACK");
  await expect(
    owner.start({
      ...input,
      expectedThreadRevision: 4,
      selection: {
        binding: { ...binding, revision: 2 },
        stage: selection.stage,
      },
    }),
  ).rejects.toThrow("project_conversation_revision_conflict");
  expect(owner.retainedSelection("thread")).toEqual(input.selection);
  await expect(
    owner.start({ ...input, expectedThreadRevision: 5 }),
  ).rejects.toBeDefined();
  expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
  expect(key).toHaveBeenCalledTimes(1);
  await owner.close();
});
it("new admission rejects a foreign or revoked Thread binding before allocating a key or sending", async () => {
  const fetch = vi.fn(),
    key = vi.fn(() => "key"),
    owner = new ControlProjectAssetStageTurn(api(fetch), key);
  for (const changed of [
    { ...binding, threadId: "other" },
    { ...binding, state: "revoked" as const },
  ])
    expect(() =>
      owner.start({
        ...input,
        selection: { ...input.selection, binding: changed },
      }),
    ).toThrow("binding_invalid");
  expect(key).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await owner.close();
});
