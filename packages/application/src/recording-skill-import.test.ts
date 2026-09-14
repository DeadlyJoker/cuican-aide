import assert from "node:assert/strict";
import test from "node:test";
import { sealRecordingExport } from "@crewon/contracts/recording";
import { createSyntheticRecordingExport } from "../../contracts/src/recording-export.fixture.ts";
import {
  recordingSkillDraft,
  RecordingSkillImporter,
} from "./recording-skill-import.ts";
import type { SkillRecordingStore } from "./skill-recording-store-port.ts";
test("F03-R01/R02 C01 synthetic contract extraction retains route, roles, candidate parameters and exceptions", async () => {
  const recording = await createSyntheticRecordingExport();
  const method = recordingSkillDraft(recording);
  assert.ok(
    method.steps.some((s) =>
      s.includes(recording.steps[0]!.page.routeTemplate),
    ),
  );
  assert.equal(
    method.steps.some((s) => s.includes("https://teaching.examplehttps://")),
    false,
  );
  assert.ok(method.steps.some((s) => s.includes("textbox / Region")));
  assert.equal(method.parameters[0]?.name, "input_3");
  assert.ok(method.steps.some((s) => s.includes("{{input_3}}")));
  assert.equal(
    method.steps.some((s) => s.includes('"North"')),
    false,
  );
  assert.deepEqual(method.requiredToolRefs, [
    "crewon_browser_observe",
    "crewon_browser_act",
  ]);
  assert.ok(method.runtimeRequirements.some((s) => s.includes("敏感")));
});
test("F03-R01 importer verifies digest before authenticated-scope persistence; C01 owner never grants access", async () => {
  const calls: unknown[] = [];
  const store: SkillRecordingStore = {
    saveImportedRecording: async (...args) => {
      calls.push(args);
    },
    readImportedRecording: async () => null,
    readRecordingEvidence: async () => null,
  };
  const importer = new RecordingSkillImporter(store);
  const recording = await createSyntheticRecordingExport();
  const actor = {
    principalId: "principal",
    actorId: "real-owner",
    tenantId: "tenant",
    spaceId: "space",
  };
  const result = await importer.importRecording(actor, recording);
  assert.equal(result.source.recordingId, recording.recordingId);
  assert.deepEqual((calls[0] as unknown[])[0], {
    tenantId: "tenant",
    spaceId: "space",
    ownerActorId: "real-owner",
  });
  await assert.rejects(
    importer.importRecording(actor, { ...recording, recordingId: "tampered" }),
  );
  assert.equal(calls.length, 1);
  const { contentDigest: _digest, ...body } = recording;
  await assert.rejects(
    importer.importRecording(
      actor,
      await sealRecordingExport({ ...body, status: "interrupted" }),
    ),
    /skill_recording_incomplete/,
  );
  assert.equal(calls.length, 1);
});
