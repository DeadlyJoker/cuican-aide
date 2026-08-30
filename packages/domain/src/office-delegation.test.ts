import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseOfficeDelegation,
  type OfficeDelegation,
} from "./office-delegation.ts";

const delegation: OfficeDelegation = {
  schemaVersion: "crewon.office-delegation.v0",
  delegationId: "delegation-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  workflowVersionBinding: {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  },
  threadId: "thread-1",
  runId: "run-1",
  requestedByActorId: "actor-1",
  createdAt: "2026-08-14T00:00:00.000Z",
};

test("parses exact immutable Office Workflow provenance", () => {
  assert.deepEqual(parseOfficeDelegation(delegation), delegation);
});

test("rejects unknown, malformed, and mutable-looking provenance", () => {
  for (const value of [
    { ...delegation, status: "running" },
    { ...delegation, delegationId: " delegation-1" },
    {
      ...delegation,
      workflowVersionBinding: {
        ...delegation.workflowVersionBinding,
        contentDigest: "a".repeat(64),
      },
    },
    Object.assign(Object.create({ inherited: true }), delegation),
  ]) {
    assert.throws(
      () => parseOfficeDelegation(value),
      /office_delegation_invalid/u,
    );
  }
});
