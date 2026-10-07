import { expect, it, vi } from "vitest";
import {
  fixture,
  hint,
  receipt,
  savedInput,
} from "./controlProjectMediaGeneration.test-support";
import { deferred } from "./controlProjectMediaInputStage.test-support";

it("reads saved input first, sends only exact saved selectors, and presents the original Run", async () => {
  const f = fixture();
  await f.ready();
  expect(f.controller.canGenerate).toBe(true);
  expect(f.posts).toHaveLength(0);
  await f.controller.generate();
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]).toEqual({
    projectId: savedInput.projectId,
    mediaInputId: savedInput.mediaInputId,
    inputRevision: 1,
    expectedInputRevision: 1,
    executionId: "key-1",
    idempotencyKey: "key-2",
    threadId: "thread",
    expectedThreadRevision: 3,
  });
  expect(f.presenter.adoptExtensionTask).toHaveBeenCalledWith(
    receipt(f.posts[0]!),
    expect.anything(),
  );
  f.controller.dispose();
});
it("cold recovery never POSTs and explicit retry keeps every original selector despite current revisions", async () => {
  const f = fixture();
  await f.ready();
  f.setPost(async (request) => {
    f.state.intent = hint(request, "dispatched");
    throw new TypeError("lost ACK");
  });
  await f.controller.generate();
  expect(f.controller.locked).toBe(true);
  f.controller.dispose();
  const cold = f.create();
  f.state.threadRevision = 9;
  await cold.refresh();
  expect(f.posts).toHaveLength(1);
  expect(cold.getSnapshot().retryable).toBe(true);
  await cold.select("different");
  await cold.generate();
  expect(f.posts).toHaveLength(1);
  f.setPost(async (request) => {
    f.state.intent = hint(request, "accepted");
    return Response.json(receipt(request));
  });
  await cold.retry();
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]).toEqual(f.posts[0]);
  cold.dispose();
});
it("accepted recovery and failed presentation require only reads, never another generation", async () => {
  const f = fixture();
  await f.ready();
  f.presenter.adoptExtensionTask.mockRejectedValueOnce(
    new Error("projection unavailable"),
  );
  await f.controller.generate();
  expect(f.controller.getSnapshot().notice).toBe("adoption-failed");
  await f.controller.showTask();
  expect(f.posts).toHaveLength(1);
  f.controller.dispose();
  const cold = f.create();
  await cold.refresh();
  await cold.showTask();
  expect(f.posts).toHaveLength(1);
  expect(cold.getSnapshot().notice).toBe("accepted");
  cold.dispose();
});
it("trusted refusal unlocks a fresh explicit command but missing recovery does not clear local uncertainty", async () => {
  const f = fixture();
  await f.ready();
  f.setPost(async (request) => {
    f.state.intent = hint(request, "refused");
    throw new TypeError("failed before task admission");
  });
  await f.controller.generate();
  f.state.intent = null;
  await f.controller.refresh();
  expect(f.controller.locked).toBe(true);
  await f.controller.generate();
  expect(f.posts).toHaveLength(1);
  f.state.intent = hint(f.posts[0]!, "refused");
  await f.controller.refresh();
  expect(f.controller.locked).toBe(false);
  expect(f.controller.getSnapshot().notice).toBe("refused");
  await f.controller.generate();
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]!.idempotencyKey).not.toBe(f.posts[0]!.idempotencyKey);
  f.controller.dispose();
});
it("foreign pending work cannot be retried or shown in this conversation", async () => {
  const f = fixture();
  await f.ready();
  await f.controller.generate();
  const request = {
    ...f.posts[0]!,
    projectId: "other-project",
    threadId: "other-thread",
    idempotencyKey: "foreign-key",
  };
  f.state.intent = hint(request, "dispatched");
  await f.controller.refresh();
  expect(f.controller.getSnapshot().foreignPending).toBe(true);
  await f.controller.retry();
  await f.controller.generate();
  expect(f.posts).toHaveLength(1);
  f.state.intent = hint(request, "accepted");
  await f.controller.refresh();
  expect(f.controller.getSnapshot().foreignPending).toBe(false);
  expect(f.controller.getSnapshot().receipt?.threadId).toBe("thread");
  f.controller.dispose();
});
it("changed bindings, historical inputs and changed configuration block new generation", async () => {
  const f = fixture();
  await f.ready();
  f.state.input.latestInputRevision = 2;
  await f.controller.select(savedInput.mediaInputId);
  expect(f.controller.canGenerate).toBe(false);
  f.state.input.latestInputRevision = 1;
  await f.controller.select(savedInput.mediaInputId);
  f.state.configurationRevision = 2;
  await f.controller.refresh();
  expect(f.controller.canGenerate).toBe(false);
  f.state.configurationRevision = 1;
  await f.controller.refresh();
  f.state.binding.workspaceId = "changed-workspace";
  await f.controller.generate();
  expect(f.posts).toHaveLength(0);
  f.controller.dispose();
});
it("repeated clicks share one request; stop waiting retains a late receipt without late presentation", async () => {
  const f = fixture();
  await f.ready();
  const gate = deferred<Response>();
  f.setPost(() => gate.promise);
  const pending = f.controller.generate();
  await vi.waitFor(() => expect(f.posts).toHaveLength(1));
  await f.controller.generate();
  f.controller.stopWaiting();
  gate.resolve(Response.json(receipt(f.posts[0]!)));
  await pending;
  expect(f.posts).toHaveLength(1);
  expect(f.controller.getSnapshot().receipt?.runId).toBe("actual-run");
  expect(f.presenter.adoptExtensionTask).not.toHaveBeenCalled();
  await f.controller.showTask();
  expect(f.presenter.adoptExtensionTask).toHaveBeenCalledOnce();
  f.controller.dispose();
});
it("disposing during reads or generation cannot present into a newly selected conversation", async () => {
  const f = fixture();
  await f.ready();
  const gate = deferred<Response>();
  f.setPost(() => gate.promise);
  const pending = f.controller.generate();
  await vi.waitFor(() => expect(f.posts).toHaveLength(1));
  f.controller.dispose();
  gate.resolve(Response.json(receipt(f.posts[0]!)));
  await pending;
  expect(f.presenter.adoptExtensionTask).not.toHaveBeenCalled();
  expect(f.posts).toHaveLength(1);
});

it("a failed new preflight never presents an older accepted receipt as the new request", async () => {
  const f = fixture();
  await f.ready();
  await f.controller.generate();
  const accepted = f.controller.getSnapshot().receipt;
  vi.spyOn(f.client, "getThread").mockRejectedValueOnce(new Error("offline"));
  await f.controller.generate();
  expect(f.posts).toHaveLength(1);
  expect(f.controller.getSnapshot().receipt).toEqual(accepted);
  expect(f.controller.getSnapshot().notice).toBe("read-failed");
  expect(f.controller.canGenerate).toBe(false);
  f.controller.dispose();
});

it("refresh rereads the latest selected input, while cold unresolved recovery reads its original version", async () => {
  const f = fixture();
  await f.ready();
  const updated = {
    ...savedInput,
    inputRevision: 2,
    prompt: "New saved version",
  };
  vi.spyOn(f.client.projectMediaInputs, "loadInput").mockResolvedValueOnce({
    state: { input: updated, latestInputRevision: 2 },
  });
  await f.controller.refresh();
  expect(f.controller.getSnapshot().selected?.input.inputRevision).toBe(2);
  expect(f.controller.getSnapshot().selected?.input.prompt).toBe(
    "New saved version",
  );
  expect(f.posts).toHaveLength(0);
  f.setPost(async (request) => {
    f.state.intent = hint(request, "dispatched");
    throw new TypeError("lost ACK");
  });
  await f.controller.generate();
  f.controller.dispose();
  const cold = f.create();
  const load = vi
    .spyOn(f.client.projectMediaInputs, "loadInput")
    .mockResolvedValue({ state: { input: updated, latestInputRevision: 3 } });
  await cold.refresh();
  expect(load).toHaveBeenLastCalledWith(
    {
      projectId: savedInput.projectId,
      mediaInputId: savedInput.mediaInputId,
      inputRevision: 2,
    },
    expect.anything(),
  );
  expect(cold.getSnapshot().selected?.input.inputRevision).toBe(2);
  expect(cold.locked).toBe(true);
  cold.dispose();
});
