import assert from "node:assert/strict";
import test from "node:test";

import { parseOfficeDefinition } from "./office.ts";

const definition = {
  schemaVersion: "crewon.office-definition.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Delivery",
  members: [
    {
      memberId: "member-1",
      displayName: "Release lead",
      agentVersionId: "agent-version-1",
    },
  ],
  executionTargets: [
    { targetId: "target-1", agentVersionId: "agent-version-1" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-08-13T00:00:00.000Z",
};

test("parses legacy Office members without a responsibility", () => {
  assert.deepEqual(parseOfficeDefinition(definition), definition);
});

test("parses a bounded immutable Office member responsibility", () => {
  const withResponsibility = {
    ...definition,
    members: [
      {
        ...definition.members[0],
        responsibility:
          "Own the release decision and preserve unresolved evidence conflicts.",
      },
    ],
  };

  assert.deepEqual(
    parseOfficeDefinition(withResponsibility),
    withResponsibility,
  );
  const emojiBoundary = {
    ...withResponsibility,
    members: [
      { ...withResponsibility.members[0], responsibility: "🚀".repeat(240) },
    ],
  };
  assert.deepEqual(parseOfficeDefinition(emojiBoundary), emojiBoundary);
  assert.throws(
    () =>
      parseOfficeDefinition({
        ...withResponsibility,
        members: [
          { ...withResponsibility.members[0], responsibility: "x".repeat(241) },
        ],
      }),
    /office_definition_invalid/u,
  );
  for (const responsibility of [" padded ", "", 42]) {
    assert.throws(
      () =>
        parseOfficeDefinition({
          ...withResponsibility,
          members: [{ ...withResponsibility.members[0], responsibility }],
        }),
      /office_definition_invalid/u,
    );
  }
  assert.throws(
    () =>
      parseOfficeDefinition({
        ...withResponsibility,
        members: [{ ...withResponsibility.members[0], unexpected: "injected" }],
      }),
    /office_definition_invalid/u,
  );
  assert.throws(
    () =>
      parseOfficeDefinition({
        ...withResponsibility,
        members: [
          {
            ...withResponsibility.members[0],
            responsibility: "🚀".repeat(241),
          },
        ],
      }),
    /office_definition_invalid/u,
  );
  assert.throws(
    () =>
      parseOfficeDefinition({
        ...withResponsibility,
        members: [
          {
            ...withResponsibility.members[0],
            responsibility: "e\u0301vidence",
          },
        ],
      }),
    /office_definition_invalid/u,
  );
});
