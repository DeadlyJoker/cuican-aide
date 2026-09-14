import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createSkillVersion,
  parseSkillInvocationSpec,
  parseSkillMethod,
  parseSkillVersion,
  parseSkillVersionRef,
  renderSkillInvocationContext,
  validateSkillInvocation,
  type SkillMethod,
} from "./demonstrated-skill.ts";
const digester = {
  sha256: (s: string) =>
    `sha256:${createHash("sha256").update(s).digest("hex")}`,
};
const method: SkillMethod = {
  name: "Monthly export",
  purpose: "Download the selected month and verify rows",
  steps: ["Select {{date}} and download"],
  parameters: [
    { name: "date", label: "New month", type: "string", required: true },
    { name: "count", label: "Rows", type: "number", required: false },
  ],
  requiredToolRefs: ["browser"],
  completionCriteria: ["Downloaded rows match count"],
  knownExceptions: ["Login: request runtime authorization"],
  runtimeRequirements: ["browser session"],
};
const version = () =>
  createSkillVersion(
    {
      skillId: "skill-1",
      versionId: "v1",
      method,
      source: {
        recordingId: "r1",
        revision: 1,
        contentDigest: digester.sha256("r"),
        provenance: "contract-fixture",
      },
      createdAt: "2026-09-14T00:00:00Z",
    },
    digester,
  );
const invocation = () => ({
  schemaVersion: "crewon.skill-invocation.v1" as const,
  skill: version().ref,
  parameters: { date: "2026-10" },
  requiredToolRefs: ["browser"],
});
test("F03-R06 strict parameter validation rejects unknown/type/missing/unsafe values", () => {
  assert.deepEqual(validateSkillInvocation(method, invocation()), invocation());
  for (const parameters of [
    {},
    { date: 1 },
    { date: "2026-10", token: "secret" },
    { date: "2026-10", count: Infinity },
    JSON.parse('{"__proto__":"bad"}'),
  ])
    assert.throws(() =>
      validateSkillInvocation(method, { ...invocation(), parameters }),
    );
  assert.throws(() =>
    parseSkillInvocationSpec({ ...invocation(), extra: true }),
  );
  assert.throws(() =>
    validateSkillInvocation(method, { ...invocation(), requiredToolRefs: [] }),
  );
  assert.throws(() =>
    parseSkillVersionRef({ ...version().ref, versionId: "latest" }),
  );
});
test("F03-R03 versions are content verified and independent of later draft edits", () => {
  const v = version();
  assert.deepEqual(parseSkillVersion(v, digester), v);
  assert.throws(
    () => parseSkillVersion({ ...v, markdown: "changed" }, digester),
    /skill_version_invalid/,
  );
  const edited = createSkillVersion(
    {
      skillId: "skill-1",
      versionId: "v2",
      method: { ...method, steps: ["Changed method"] },
      source: v.source,
      createdAt: v.createdAt,
    },
    digester,
  );
  assert.notEqual(edited.ref.contentDigest, v.ref.contentDigest);
  assert.match(v.markdown, /Select/);
});
test("F03-R08 deterministic bounded context contains new parameters without raw recording", () => {
  const context = renderSkillInvocationContext(version(), invocation());
  assert.match(context, /2026-10/);
  assert.ok(Buffer.byteLength(context) < 9216);
  assert.equal(context, renderSkillInvocationContext(version(), invocation()));
  assert.throws(
    () =>
      renderSkillInvocationContext(version(), {
        ...invocation(),
        skill: { ...version().ref, contentDigest: digester.sha256("wrong") },
      }),
    /mismatch/,
  );
  assert.throws(
    () =>
      parseSkillMethod({
        ...method,
        steps: Array.from({ length: 20 }, () => "大".repeat(300)),
      }),
    /too_large/,
  );
});
test("F03-R06 schemas reject unknown fields and invalid enum/secret types", () => {
  for (const field of [
    { name: "password", label: "password", type: "secret", required: true },
    {
      name: "date",
      label: "date",
      type: "number",
      required: true,
      enum: ["1"],
    },
    { name: "constructor", label: "bad", type: "string", required: true },
  ])
    assert.throws(() => parseSkillMethod({ ...method, parameters: [field] }));
});
