import assert from "node:assert/strict";
import { test } from "node:test";

import { parseOfficeDefinition, type OfficeDefinition } from "./office.ts";

const definition: OfficeDefinition = {
  schemaVersion: "crewon.office-definition.v0",
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Delivery office",
  members: [
    {
      memberId: "member-1",
      displayName: "Planner",
      agentVersionId: "agent-version-1",
    },
  ],
  executionTargets: [
    { targetId: "primary", agentVersionId: "agent-version-1" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-08-13T00:00:00.000Z",
};

test("parses one canonical Office definition", () => {
  assert.deepEqual(parseOfficeDefinition(definition), definition);
});

test("rejects unknown fields and non-canonical bounded text", () => {
  assert.throws(
    () => parseOfficeDefinition({ ...definition, legacyKey: true }),
    /office_definition_invalid/,
  );
  assert.throws(
    () =>
      parseOfficeDefinition({
        ...definition,
        members: [{ ...definition.members[0], displayName: "e\u0301" }],
      }),
    /office_definition_invalid/,
  );
  assert.throws(
    () =>
      parseOfficeDefinition({
        ...definition,
        executionTargets: [
          ...definition.executionTargets,
          definition.executionTargets[0],
        ],
      }),
    /office_definition_invalid/,
  );
});
