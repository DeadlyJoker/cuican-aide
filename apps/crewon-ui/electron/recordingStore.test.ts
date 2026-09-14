import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RECORDING_BUDGETS,
  validateRecordingExport,
  sealRecordingExport,
} from "@crewon/contracts/recording";
import { RecordingStore, type ObservedStep } from "./recordingStore.ts";

const roots: string[] = [];
async function store() {
  const root = await mkdtemp(join(tmpdir(), "crewon-recording-"));
  roots.push(root);
  const store = new RecordingStore(root);
  await store.initialize();
  return { root, store };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const event: ObservedStep = {
  kind: "click",
  page: {
    origin: "https://example.test",
    routeTemplate: "https://example.test/orders?date={runtime}",
    routeDigest: `sha256:${"0".repeat(64)}`,
  },
  target: {
    tag: "button",
    selector: "body > button:nth-of-type(1)",
    description: "button",
    role: "button",
    accessibleName: "Download",
  },
  input: null,
  note: null,
  outcome: "observed",
  reason: null,
  relatedStepId: null,
};
const layout = '<svg xmlns="http://www.w3.org/2000/svg"/>';

describe("recording store behavior", () => {
  it("persists steps, ignores paused capture, preserves identity on deletion and rejects stale edits", async () => {
    const { store: s } = await store();
    const start = await s.start(event.page.origin);
    const first = await s.append(event, layout);
    expect(first.steps).toHaveLength(1);
    const id = first.steps[0]!.stepId;
    const paused = await s.control("pause", first.revision);
    expect((await s.append(event)).steps).toHaveLength(1);
    const resumed = await s.control(
      "resume",
      paused.revision,
      event.page.origin,
    );
    const second = await s.append(event);
    expect(second.steps[1]!.sequence).toBe(2);
    await expect(
      s.edit({
        stepId: id,
        operation: "delete",
        note: null,
        expectedRevision: resumed.revision,
      }),
    ).rejects.toThrow("revision_conflict");
    const beforeEdit = await s.control("pause", second.revision);
    const deleted = await s.edit({
      stepId: id,
      operation: "delete",
      note: null,
      expectedRevision: beforeEdit.revision,
    });
    expect(deleted.steps[0]!.sequence).toBe(2);
    expect(deleted.evidence).toHaveLength(0);
    expect(deleted.edits[0]!.stepId).toBe(id);
    expect(start.scope.ownerId).toBe(deleted.scope.ownerId);
  });

  it("reopens unfinished recordings interrupted, keeping unknown download outcomes", async () => {
    const { store: s, root } = await store();
    await s.start(event.page.origin);
    const previous = await s.append({
      ...event,
      kind: "download",
      outcome: "unknown",
    });
    const reopened = new RecordingStore(root);
    await reopened.initialize();
    expect(reopened.current!.status).toBe("interrupted");
    expect(reopened.current!.revision).toBe(previous.revision + 1);
    expect(reopened.current!.steps[0]!.outcome).toBe("unknown");
    await reopened.control(
      "resume",
      reopened.current!.revision,
      event.page.origin,
    );
    expect(reopened.current!.status).toBe("recording");
  });

  it("stops at elapsed budget before retaining another event", async () => {
    const { root } = await store();
    let now = Date.now();
    const s = new RecordingStore(root, () => new Date(now));
    await s.initialize();
    await s.start(event.page.origin);
    now += RECORDING_BUDGETS.maxDurationMs + 1;
    const result = await s.append(event);
    expect(result.status).toBe("budget-exceeded");
    expect(result.steps).toHaveLength(0);
  });

  it("serializes concurrent writes and keeps exported disk digest verifiable", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    await Promise.all([s.append(event), s.append(event)]);
    expect(s.current!.steps.map((x) => x.sequence)).toEqual([1, 2]);
    const disk = JSON.parse(
      await readFile(join(root, start.recordingId, "recording.json"), "utf8"),
    );
    expect((await validateRecordingExport(disk)).revision).toBe(
      s.current!.revision,
    );
  });

  it("F02-R07 retains 200 ordered events and closes capture on the next event", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    for (let index = 0; index < RECORDING_BUDGETS.maxSteps; index += 1)
      await s.append(event);
    const before = s.current!;
    expect(before.status).toBe("recording");
    expect(before.steps.map((step) => step.sequence)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    const exceeded = await s.append(event, layout);
    expect(exceeded.status).toBe("budget-exceeded");
    expect(exceeded.steps).toEqual(before.steps);
    expect(exceeded.revision).toBe(before.revision + 1);
    await expect(
      readFile(join(root, start.recordingId, "evidence-201.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await s.append(event)).toEqual(exceeded);
  });

  it("F02-R07 deleting steps does not reopen the original 200-event budget", async () => {
    const { store: s } = await store();
    await s.start(event.page.origin);
    for (let index = 0; index < RECORDING_BUDGETS.maxSteps; index += 1)
      await s.append(event);
    const paused = await s.control("pause", s.current!.revision);
    const deleted = await s.edit({
      stepId: "step-200",
      operation: "delete",
      note: null,
      expectedRevision: paused.revision,
    });
    await s.control("resume", deleted.revision, event.page.origin);
    const exceeded = await s.append(event);
    expect(exceeded.status).toBe("budget-exceeded");
    expect(exceeded.steps).toHaveLength(199);
    expect(exceeded.edits.at(-1)?.stepId).toBe("step-200");
  });

  it("F02-R07 oversized evidence closes capture without persisting its body", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    const exceeded = await s.append(
      event,
      "x".repeat(RECORDING_BUDGETS.maxEvidenceBytes + 1),
    );
    expect(exceeded.status).toBe("budget-exceeded");
    expect(exceeded.steps).toHaveLength(0);
    expect(exceeded.evidence).toHaveLength(0);
    await expect(
      readFile(join(root, start.recordingId, "evidence-1.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("F02-R03 preserves original local scope and authorization when explicitly adding another source", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    const otherOrigin = "https://other.example";
    const otherEvent: ObservedStep = {
      ...event,
      page: {
        ...event.page,
        origin: otherOrigin,
        routeTemplate: `${otherOrigin}/orders`,
      },
    };
    await expect(s.append(otherEvent)).rejects.toThrow("unauthorized_origin");
    expect(s.current).toEqual(start);
    const paused = await s.control("pause", start.revision);
    const resumed = await s.control("resume", paused.revision, otherOrigin);
    expect(resumed.scope).toEqual(start.scope);
    expect(resumed.scope.workspaceId).toBeNull();
    expect(resumed.authorization).toEqual({
      ...start.authorization,
      allowedOrigins: [event.page.origin, otherOrigin],
    });
    const observed = await s.append(otherEvent);
    expect(observed.steps[0]!.page.origin).toBe(otherOrigin);
    const reopened = new RecordingStore(root);
    await reopened.initialize();
    expect(reopened.current!.scope).toEqual(start.scope);
    expect(reopened.current!.authorization).toEqual(resumed.authorization);
  });

  it("F02-R02 completion after finish cannot turn an unconfirmed download into success", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    const download = await s.append({
      ...event,
      kind: "download",
      outcome: "unknown",
    });
    const completed = await s.control("finish", download.revision);
    expect(
      await s.updateDownload(
        start.recordingId,
        download.steps[0]!.stepId,
        "completed",
      ),
    ).toEqual(completed);
    expect(
      await s.updateDownload(
        start.recordingId,
        download.steps[0]!.stepId,
        "cancelled",
      ),
    ).toEqual(completed);
    const reopened = new RecordingStore(root);
    await reopened.initialize();
    expect(reopened.current!.status).toBe("completed");
    expect(reopened.current!.steps[0]!.outcome).toBe("unknown");
    expect(reopened.current!.revision).toBe(completed.revision);
  });

  it("F02-R05 a failed atomic document write preserves the last confirmed snapshot and revision", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    const before = await s.append(event);
    const file = join(root, start.recordingId, "recording.json");
    const diskBefore = await readFile(file, "utf8");
    const temporaryFile = join(root, start.recordingId, "recording.tmp");
    await mkdir(temporaryFile);
    await expect(s.append(event)).rejects.toMatchObject({ code: "EISDIR" });
    expect(s.current).toEqual(before);
    expect(await readFile(file, "utf8")).toBe(diskBefore);
    await rm(temporaryFile, { recursive: true });
    const recovered = await s.append(event);
    expect(recovered.steps.map((step) => step.stepId)).toEqual([
      "step-1",
      "step-2",
    ]);
    expect(recovered.revision).toBe(before.revision + 1);
    expect(
      await validateRecordingExport(JSON.parse(await readFile(file, "utf8"))),
    ).toEqual(recovered);
  });

  it("F02-R06 rejects evidence outside current ownership and verifies its bytes before returning a data URL", async () => {
    const { store: s, root } = await store();
    const first = await s.start(event.page.origin);
    await s.append(event, layout);
    const firstData = `data:image/svg+xml;base64,${Buffer.from(layout).toString("base64")}`;
    expect(await s.evidence("evidence-1")).toBe(firstData);
    await expect(s.evidence("../owner")).rejects.toThrow(
      "recording_evidence_missing",
    );
    await expect(s.evidence("evidence-999")).rejects.toThrow(
      "recording_evidence_missing",
    );
    const evidencePath = join(root, first.recordingId, "evidence-1.bin");
    await writeFile(evidencePath, layout.replace("svg", "xxx"));
    await expect(s.evidence("evidence-1")).rejects.toThrow(
      "recording_evidence_mismatch",
    );
    await writeFile(evidencePath, `${layout}extra`);
    await expect(s.evidence("evidence-1")).rejects.toThrow(
      "recording_evidence_mismatch",
    );
    await writeFile(evidencePath, layout);
    await s.control("finish", s.current!.revision);
    const second = await s.start(event.page.origin);
    await expect(s.evidence("evidence-1")).rejects.toThrow(
      "recording_evidence_missing",
    );
    const otherLayout = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    await s.append(event, otherLayout);
    expect(await s.evidence("evidence-1")).toBe(
      `data:image/svg+xml;base64,${Buffer.from(otherLayout).toString("base64")}`,
    );
    await s.control("finish", s.current!.revision);
    await s.select(first.recordingId);
    expect(await s.evidence("evidence-1")).toBe(firstData);
    expect(s.current!.recordingId).not.toBe(second.recordingId);
  });

  it("F02-R04 deleting a trigger clears its download relation and removes its evidence bytes", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    await s.append(event, layout);
    const download = await s.append({
      ...event,
      kind: "download",
      relatedStepId: "step-1",
      outcome: "unknown",
    });
    const paused = await s.control("pause", download.revision);
    const edited = await s.edit({
      stepId: "step-1",
      operation: "delete",
      note: null,
      expectedRevision: paused.revision,
    });
    expect(edited.steps[0]!.stepId).toBe("step-2");
    expect(edited.steps[0]!.relatedStepId).toBeNull();
    expect(edited.steps[0]!.outcome).toBe("unknown");
    await expect(s.evidence("evidence-1")).rejects.toThrow(
      "recording_evidence_missing",
    );
    await expect(
      readFile(join(root, start.recordingId, "evidence-1.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("F02-R03 rejects unauthorized source events before retaining their evidence", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    const unauthorized = {
      ...event,
      page: {
        ...event.page,
        origin: "https://other.example",
        routeTemplate: "https://other.example/orders",
      },
    };
    await expect(s.append(unauthorized, layout)).rejects.toThrow(
      "unauthorized_origin",
    );
    expect(s.current).toEqual(start);
    await expect(
      readFile(join(root, start.recordingId, "evidence-1.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("F02-R05 removes evidence for an operation whose document commit fails", async () => {
    const { store: s, root } = await store();
    const start = await s.start(event.page.origin);
    await mkdir(join(root, start.recordingId, "recording.tmp"));
    await expect(s.append(event, layout)).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(s.current).toEqual(start);
    await expect(
      readFile(join(root, start.recordingId, "evidence-1.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["owner", "recording-id"])(
    "F02-R06 reopening rejects a validly sealed but mismatched %s declaration",
    async (mismatch) => {
      const { store: s, root } = await store();
      const start = await s.start(event.page.origin);
      const completed = await s.control("finish", start.revision);
      const { contentDigest: _digest, ...body } = completed;
      if (mismatch === "owner")
        body.scope = { ...body.scope, ownerId: "desktop-unrelated-owner" };
      else body.recordingId = "rec-unrelated-recording";
      const tampered = await sealRecordingExport(body);
      await writeFile(
        join(root, start.recordingId, "recording.json"),
        JSON.stringify(tampered),
      );
      const reopened = new RecordingStore(root);
      await expect(reopened.initialize()).rejects.toThrow(
        "recording_scope_mismatch",
      );
      expect(reopened.current).toBeNull();
    },
  );
});
