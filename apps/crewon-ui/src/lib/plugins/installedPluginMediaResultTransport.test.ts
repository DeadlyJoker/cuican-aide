// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_MEDIA_RESULT_UI_ACTIONS as actions } from "@crewon/contracts/project-media-results-ui";
import {
  controlUiClient,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import { uiLease, deferred } from "./pluginUiLoader.test-support";
import { createInstalledPluginMediaResultTransport } from "./installedPluginMediaResultTransport";
const lease = uiLease(),
  bytes = new Uint8Array(64);
const candidate = {
  projectId: "project",
  candidateId: "result-" + "a".repeat(64),
  runId: "run",
  resultIndex: 0,
  executionId: "execution",
  mediaInputId: "input",
  inputRevision: 2,
  workflowId: "krea2-reference-four-view",
  item: { kind: "character-reference", assetId: "character" },
  contentDigest: "sha256:" + "b".repeat(64),
  media: {
    type: "image/png",
    byteDigest:
      "sha256:f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b",
    byteLength: bytes.length,
    width: 1,
    height: 1,
    observedAt: "2026-10-07T00:00:00.000Z",
  },
};
const query = { projectId: "project", runId: "run", resultIndex: 0 };
function fixture() {
  const state = {
    allowed: true,
    corrupt: false,
    gate: null as ReturnType<typeof deferred> | null,
  };
  const wire = controlUiClient(async (url, init) => {
    if (url.pathname.endsWith("/content")) {
      await state.gate?.promise;
      return new Response(state.corrupt ? new Uint8Array(63) : bytes, {
        headers: {
          "content-type": "image/png",
          "content-length": "64",
          "x-crewon-candidate-id": candidate.candidateId,
          "x-crewon-byte-digest": candidate.media.byteDigest,
        },
      });
    }
    expect(init.method).toBe("POST");
    return controlUiResponse({ output: { candidate } });
  });
  let n = 0;
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:http://localhost/preview-${++n}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const validateLease = vi.fn(async () => {
    if (!state.allowed) throw new Error("mount_closed");
    return lease;
  });
  const transport = createInstalledPluginMediaResultTransport({
    client: wire.client,
    assertCurrent() {
      if (!state.allowed) throw new Error("session_changed");
    },
    validateLease,
  });
  const preview = () =>
    transport.invoke(lease, {
      action: actions.preview,
      input: query,
      signal: new AbortController().signal,
    });
  return { state, wire, create, revoke, transport, preview, validateLease };
}
afterEach(() => vi.restoreAllMocks());
describe("plugin-owned verified result previews", () => {
  it("reads through the authenticated client, creates one image Blob, and releases only the matching mount URL", async () => {
    const f = fixture();
    const a = (await f.preview()) as { url: string };
    expect(f.create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((f.create.mock.calls[0][0] as Blob).type).toBe("image/png");
    expect(f.validateLease).toHaveBeenCalledOnce();
    const b = (await f.preview()) as { url: string };
    expect(f.revoke).toHaveBeenCalledWith(a.url);
    await f.transport.invoke(lease, {
      action: actions.releasePreview,
      input: { url: a.url },
      signal: new AbortController().signal,
    });
    expect(f.revoke).not.toHaveBeenCalledWith(b.url);
    f.transport.release(uiLease(2));
    expect(f.revoke).not.toHaveBeenCalledWith(b.url);
    f.transport.release(lease);
    expect(f.revoke).toHaveBeenCalledWith(b.url);
    expect(
      f.wire.fetch.mock.calls.every(
        ([, init]) =>
          new Headers(init?.headers).get("authorization") ===
          "Bearer captured-user-token",
      ),
    ).toBe(true);
  });
  it("corrupt bytes or a withdrawn session never become an image URL", async () => {
    const f = fixture();
    f.state.corrupt = true;
    await expect(f.preview()).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    f.state.corrupt = false;
    f.state.allowed = false;
    await expect(f.preview()).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("release during a pending download prevents late URLs", async () => {
    const f = fixture();
    f.state.gate = deferred();
    const pending = f.preview();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.wire.fetch).toHaveBeenCalledTimes(2));
    f.transport.release(lease);
    f.state.gate.resolve(undefined);
    await rejected;
    expect(f.create).not.toHaveBeenCalled();
  });
  it("an unknown namespace action and foreign release shape cannot escape into HTTP", async () => {
    const f = fixture();
    await expect(
      f.transport.invoke(lease, {
        action: "crewon.project-media-results.v1.publish",
        input: query,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    await expect(
      f.transport.invoke(lease, {
        action: actions.releasePreview,
        input: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(f.wire.fetch).not.toHaveBeenCalled();
  });
});
