// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  RecordingSkillImportListener,
  RecordingSkillImportRequest,
} from "../../lib/desktop/recordingBridge";
import { useRecordingSkillImport } from "./useRecordingSkillImport";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const request: RecordingSkillImportRequest = {
  requestId: "handoff-1",
  recording: {
    schemaVersion: 1,
    recordingId: "recording-contract-fixture",
    revision: 2,
    contentDigest: `sha256:${"a".repeat(64)}`,
    scope: { ownerId: "fixture", workspaceId: null },
    authorization: {
      source: "desktop-user-start",
      authorizedAt: "2026-09-14T00:00:00Z",
      allowedOrigins: ["https://example.test"],
    },
    startedAt: "2026-09-14T00:00:00Z",
    updatedAt: "2026-09-14T00:00:01Z",
    status: "completed",
    steps: [],
    evidence: [],
    edits: [],
  },
  evidence: [
    {
      evidenceId: "evidence-1",
      mediaType: "image/svg+xml",
      dataBase64: "PHN2Zz4=",
    },
  ],
};

function bridgeFixture() {
  let listener!: RecordingSkillImportListener;
  const unsubscribe = vi.fn();
  return {
    bridge: {
      onSkillImportRequest: vi.fn((value: RecordingSkillImportListener) => {
        listener = value;
        return unsubscribe;
      }),
    },
    send: (value = request) => listener(value),
    unsubscribe,
  };
}

it("uses the authenticated Skill transport and opens the server-returned Skill only after a successful import", async () => {
  const f = bridgeFixture();
  const onImported = vi.fn();
  const controlClient = {
    requestSkill: vi.fn(async () =>
      Response.json({ skillId: "imported-skill" }),
    ),
  };
  let hook!: ReturnType<typeof useRecordingSkillImport>;
  function Probe() {
    hook = useRecordingSkillImport({
      controlClient,
      bridge: f.bridge,
      onImported,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    expect(controlClient.requestSkill).not.toHaveBeenCalled();
    await act(async () => {
      expect(await f.send()).toEqual({
        ok: true,
        message: "录制已导入为待审阅草稿，请在主窗口继续整理方法。",
        skillId: "imported-skill",
      });
    });
    const [path, init] = vi.mocked(controlClient.requestSkill).mock
      .calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/skills");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("idempotency-key")).toBe(
      request.requestId,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      recording: request.recording,
      evidence: request.evidence,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(hook.openRequest).toEqual({
      requestId: "handoff-1",
      skillId: "imported-skill",
    });
    expect(onImported).toHaveBeenCalledOnce();
    await act(async () => hook.acknowledgeOpen("other-request"));
    expect(hook.openRequest).not.toBeNull();
    await act(async () => hook.acknowledgeOpen("handoff-1"));
    expect(hook.openRequest).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});

it("retries an uncertain import using the original body and key even when the recorder emits a new handoff id", async () => {
  const f = bridgeFixture();
  const onImported = vi.fn();
  const onFailure = vi.fn();
  const controlClient = {
    requestSkill: vi
      .fn()
      .mockRejectedValueOnce(new Error("lost_ack"))
      .mockResolvedValue(Response.json({ skillId: "same-skill" })),
  };
  function Probe() {
    useRecordingSkillImport({
      controlClient,
      bridge: f.bridge,
      onImported,
      onFailure,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () =>
      expect(await f.send()).toMatchObject({
        ok: false,
        message: expect.stringContaining("重试"),
      }),
    );
    expect(onImported).not.toHaveBeenCalled();
    await act(async () =>
      expect(
        await f.send({ ...request, requestId: "handoff-2" }),
      ).toMatchObject({ ok: true, skillId: "same-skill" }),
    );
    const calls = controlClient.requestSkill.mock.calls;
    expect(calls[1][1].body).toBe(calls[0][1].body);
    expect(new Headers(calls[1][1].headers).get("idempotency-key")).toBe(
      "handoff-1",
    );
    await act(async () =>
      expect(
        await f.send({ ...request, requestId: "handoff-3" }),
      ).toMatchObject({ skillId: "same-skill" }),
    );
    expect(controlClient.requestSkill).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it("deduplicates simultaneous handoffs and aborts without navigation on unmount", async () => {
  const f = bridgeFixture();
  const onImported = vi.fn();
  let finish!: (value: Response) => void;
  const controlClient = {
    requestSkill: vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  function Probe() {
    useRecordingSkillImport({ controlClient, bridge: f.bridge, onImported });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const first = f.send();
  const second = f.send({ ...request, requestId: "handoff-2" });
  expect(controlClient.requestSkill).toHaveBeenCalledOnce();
  const signal = (
    controlClient.requestSkill.mock.calls[0] as unknown as [string, RequestInit]
  )[1].signal!;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  finish(Response.json({ skillId: "already-imported" }));
  expect(await first).toMatchObject({ ok: false });
  expect(await second).toMatchObject({ ok: false });
  expect(onImported).not.toHaveBeenCalled();
});

it("fails closed on a denied response or reused request id with changed content", async () => {
  const f = bridgeFixture();
  const onImported = vi.fn();
  const controlClient = {
    requestSkill: vi.fn(async () =>
      Response.json({ error: { code: "denied" } }, { status: 403 }),
    ),
  };
  function Probe() {
    useRecordingSkillImport({ controlClient, bridge: f.bridge, onImported });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () =>
      expect(await f.send()).toMatchObject({
        ok: false,
        message: expect.stringContaining("权限"),
      }),
    );
    await act(async () =>
      expect(await f.send({ ...request, evidence: [] })).toMatchObject({
        ok: false,
        message: expect.stringContaining("内容变化"),
      }),
    );
    expect(controlClient.requestSkill).toHaveBeenCalledOnce();
    expect(onImported).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels the previous authenticated registration and does not carry its import across identities", async () => {
  const f = bridgeFixture();
  const onImported = vi.fn();
  let finish!: (value: Response) => void;
  const oldClient = {
    requestSkill: vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const nextClient = {
    requestSkill: vi.fn(async () =>
      Response.json({ skillId: "new-account-skill" }),
    ),
  };
  function Probe({
    client,
  }: {
    client: {
      requestSkill(path: string, init?: RequestInit): Promise<Response>;
    };
  }) {
    useRecordingSkillImport({
      controlClient: client,
      bridge: f.bridge,
      onImported,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe client={oldClient} />));
    const oldRequest = f.send();
    await act(async () => root.render(<Probe client={nextClient} />));
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    finish(Response.json({ skillId: "old-account-skill" }));
    expect(await oldRequest).toMatchObject({ ok: false });
    expect(onImported).not.toHaveBeenCalled();
    await act(async () =>
      expect(await f.send()).toMatchObject({ skillId: "new-account-skill" }),
    );
    expect(onImported).toHaveBeenCalledWith("new-account-skill");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not advertise desktop import until an authenticated Control client exists", async () => {
  const f = bridgeFixture();
  function Probe() {
    useRecordingSkillImport({ controlClient: null, bridge: f.bridge });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    expect(f.bridge.onSkillImportRequest).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
