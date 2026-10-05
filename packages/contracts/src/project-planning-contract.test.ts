import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectPlanningCapabilities,
  parseProjectPlanningCapability,
  parseProjectPlanningProposal,
  parseProjectPlanningProposalInput,
} from "./project-planning-contract.ts";
const digest = `sha256:${"a".repeat(64)}`;
const capability = {
  capabilityId: digest,
  source: {
    pluginId: "example.drama",
    publisherId: "example.publisher",
    version: "18.0.0",
    packageDigest: digest,
    contributionId: "workbench",
  },
  title: "AI 短剧",
  kind: "short-drama",
  stages: ["brief", "outline", "script"],
  maximumEpisodes: 16,
  moduleAvailable: true,
  textPlansAvailable: true,
  executionReady: true,
};
const input = {
  capabilityId: digest,
  title: "雨夜来信",
  briefText: "两位老友\n重逢",
  instruction: "写出三集故事",
  start: "outline",
  target: "script",
  episodeCount: 3,
  adoption: "manual",
};
const proposal = {
  schemaVersion: "crewon.project-planning-proposal.v1",
  kind: "newProject",
  capability,
  origin: { runId: "run", threadId: "thread", callId: "call" },
  input,
};
test("planning DTO preserves bounded multiline drafts and host origin without write authority", () => {
  const parsed = parseProjectPlanningProposal(proposal);
  assert.deepEqual(parsed, proposal);
  assert.ok(Object.isFrozen(parsed.input));
  assert.throws(() =>
    parseProjectPlanningProposalInput({ ...input, origin: proposal.origin }),
  );
  assert.throws(() =>
    parseProjectPlanningProposal({ ...proposal, grant: true }),
  );
  assert.throws(() =>
    parseProjectPlanningProposal({
      ...proposal,
      input: { ...input, capabilityId: `sha256:${"b".repeat(64)}` },
    }),
  );
  assert.equal(
    parseProjectPlanningCapability({ ...capability, executionReady: false })
      .executionReady,
    false,
  );
  assert.throws(() =>
    parseProjectPlanningCapability({ ...capability, moduleAvailable: false }),
  );
});
test("planning ranges reject unsupported stages, counts and adoption while preserving manual default data", () => {
  for (const patch of [
    { start: "script" },
    { start: "outline", target: "brief", episodeCount: null },
    { target: "brief", episodeCount: 1 },
    { episodeCount: 0 },
    { episodeCount: 17 },
    { episodeCount: 1.5 },
    { adoption: "always" },
  ])
    assert.throws(() =>
      parseProjectPlanningProposalInput({ ...input, ...patch }),
    );
  assert.equal(
    parseProjectPlanningProposalInput({
      ...input,
      start: "brief",
      target: "brief",
      episodeCount: null,
    }).episodeCount,
    null,
  );
});
test("planning fields and entire transcript fragment have independent UTF-8 budgets", () => {
  assert.throws(() =>
    parseProjectPlanningProposalInput({ ...input, title: "中".repeat(43) }),
  );
  assert.throws(() =>
    parseProjectPlanningProposalInput({
      ...input,
      briefText: "中".repeat(1366),
    }),
  );
  assert.throws(() =>
    parseProjectPlanningProposalInput({
      ...input,
      instruction: "x".repeat(2049),
    }),
  );
  assert.throws(() =>
    parseProjectPlanningProposalInput({ ...input, title: "a\nb" }),
  );
  assert.throws(() =>
    parseProjectPlanningProposalInput({ ...input, briefText: "a\u0000b" }),
  );
  assert.throws(() =>
    parseProjectPlanningCapabilities({
      schemaVersion: "crewon.project-planning-capabilities.v1",
      capabilities: Array(9).fill(capability),
    }),
  );
  assert.throws(() =>
    parseProjectPlanningCapabilities({
      schemaVersion: "crewon.project-planning-capabilities.v1",
      capabilities: [capability, capability],
    }),
  );
});
test("planning parsers never evaluate getters, toJSON, sparse arrays or surrogate injection", () => {
  let reads = 0;
  assert.throws(() =>
    parseProjectPlanningProposalInput({
      ...input,
      get title() {
        reads++;
        return "oops";
      },
    }),
  );
  assert.throws(() =>
    parseProjectPlanningProposalInput({
      ...input,
      toJSON() {
        reads++;
        return input;
      },
    }),
  );
  assert.throws(() =>
    parseProjectPlanningCapability({ ...capability, stages: new Array(3) }),
  );
  assert.throws(() =>
    parseProjectPlanningProposalInput({ ...input, title: "\ud800" }),
  );
  assert.equal(reads, 0);
});
