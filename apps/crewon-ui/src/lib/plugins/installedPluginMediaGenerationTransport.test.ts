// @vitest-environment happy-dom
import { ControlApiTransportError } from "@crewon/control-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePluginUiLease,
  PLUGIN_UI_RECOVERY_VERSION,
} from "@crewon/contracts/plugins";
import { PROJECT_MEDIA_GENERATE_UI_ACTION } from "@crewon/contracts/project-media-generations";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";
import {
  recoveryHostFixture,
  recoveryHint,
} from "./installedPluginUiRecovery.test-support";
import { controlUiResponse } from "./controlPluginUi.test-support";
import { deferred, flush } from "./pluginUiLoader.test-support";

const handles: PluginUiMountHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const request = {
  action: PROJECT_MEDIA_GENERATE_UI_ACTION,
  input: {
    projectId: "media-project",
    mediaInputId: "saved-input",
    inputRevision: 2,
    expectedInputRevision: 2,
    executionId: "original-execution",
    threadId: "bound-thread",
    expectedThreadRevision: 4,
    idempotencyKey: "original-key",
  },
} as const;
const receipt = {
  disposition: "committed",
  projectId: request.input.projectId,
  mediaInputId: request.input.mediaInputId,
  inputRevision: 2,
  executionId: request.input.executionId,
  threadId: request.input.threadId,
  threadRevision: 5,
  runId: "original-run",
} as const;
const accepted = () =>
  recoveryHint(request, "prepared", {
    phase: "accepted",
    revision: 3,
    dispatchAttemptCount: 1,
    dispatchMayHaveOccurred: true,
    retryable: false,
    receipt,
  });
async function fixture(native: boolean, recovery = true) {
  const f = recoveryHostFixture(native, recovery);
  f.setLease(
    parsePluginUiLease({
      ...f.lease,
      descriptor: {
        ...f.lease.descriptor,
        requires: [
          ...f.lease.descriptor.requires,
          {
            service: "crewon.project-media-generations",
            apiVersion: "1",
            optional: true,
          },
        ],
      },
    }),
  );
  f.setBusiness(() => controlUiResponse({ output: receipt }));
  handles.push(await f.mount());
  const invoke = (signal?: AbortSignal) =>
    f.h.instances[0].services.invoke(request.action, request.input, { signal });
  return { ...f, invoke };
}
describe.each([false, true])("media generation Web/Native %s", (native) => {
  it("stages the full original request before business dispatch and uses the long deadline only there", async () => {
    const f = await fixture(native),
      timeout = vi.spyOn(AbortSignal, "timeout");
    await expect(f.invoke()).resolves.toEqual(receipt);
    const writes = f.fetch.mock.calls.filter(
      ([url, init]) =>
        init?.method === "POST" && /\/(recovery|actions)$/.test(String(url)),
    );
    expect(
      writes.map(([url]) => new URL(String(url)).pathname.split("/").at(-1)),
    ).toEqual(["recovery", "actions"]);
    for (const [, init] of writes)
      expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(timeout.mock.calls.some(([ms]) => ms === 90_000)).toBe(true);
    expect(f.journals.every((j) => j.snapshot().length === 0)).toBe(true);
  });
  it("returns a durable accepted receipt without dispatching or replacing the request", async () => {
    const f = await fixture(native);
    f.setStage(() =>
      controlUiResponse({
        version: PLUGIN_UI_RECOVERY_VERSION,
        disposition: "replayed",
        intent: accepted(),
      }),
    );
    await expect(f.invoke()).resolves.toEqual(receipt);
    expect(f.wire("/actions")).toHaveLength(0);
  });
  it("fails closed without recovery or when its acknowledgement changes the intent", async () => {
    const disabled = await fixture(native, false);
    await expect(disabled.invoke()).rejects.toThrow(
      "plugin_ui_recovery_unavailable",
    );
    expect(disabled.wire("/recovery")).toHaveLength(0);
    expect(disabled.wire("/actions")).toHaveLength(0);
    const f = await fixture(native);
    f.setStage(() =>
      controlUiResponse({
        version: PLUGIN_UI_RECOVERY_VERSION,
        disposition: "created",
        intent: recoveryHint({
          ...request,
          input: { ...request.input, executionId: "foreign-execution" },
        }),
      }),
    );
    await expect(f.invoke()).rejects.toThrow();
    expect(f.wire("/actions")).toHaveLength(0);
  });
  it("does not dispatch after an aborted or lost stage response", async () => {
    const f = await fixture(native),
      gate = deferred<Response>(),
      caller = new AbortController();
    f.setStage(() => gate.promise);
    const pending = f.invoke(caller.signal);
    void pending.catch(() => {});
    await flush();
    caller.abort();
    await expect(pending).rejects.toThrow();
    gate.resolve(
      controlUiResponse({
        version: PLUGIN_UI_RECOVERY_VERSION,
        disposition: "created",
        intent: recoveryHint(request),
      }),
    );
    await flush();
    expect(f.wire("/actions")).toHaveLength(0);
    const lostResponse = new Error("named-lost-stage-response");
    f.setStage(() => {
      throw lostResponse;
    });
    await expect(f.invoke()).rejects.toMatchObject({
      constructor: ControlApiTransportError,
      message: "control_api_transport_unavailable",
      cause: lostResponse,
    });
    expect(f.wire("/actions")).toHaveLength(0);
  });
  it("cancel and account replacement suppress late receipts and never retry automatically", async () => {
    const f = await fixture(native),
      gate = deferred<Response>(),
      caller = new AbortController();
    f.setBusiness(() => gate.promise);
    const pending = f.invoke(caller.signal);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(f.wire("/actions")).toHaveLength(1));
    caller.abort();
    await expect(pending).rejects.toThrow();
    expect(f.wire("/actions")[0][1]?.signal?.aborted).toBe(true);
    f.revoke();
    gate.resolve(controlUiResponse({ output: receipt }));
    await flush();
    expect(f.wire("/actions")).toHaveLength(1);
    expect(f.journals.every((j) => j.snapshot().length === 0)).toBe(true);
  });
});
