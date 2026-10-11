import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDesktopNativeProjectWorkspaceResponse as response,
  parseDesktopNativeProjectWorkspaceTicket as ticket,
} from "./desktop-native-project-workspace-contract.ts";
const validTicket = {
  schemaVersion: "crewon.desktop-native-project-workspace-ticket.v1",
  ticketId: "a".repeat(64),
  expiresAt: "2026-10-12T00:00:00.000Z",
};
const validResponse = {
  schemaVersion: "crewon.desktop-native-project-workspace-response.v1",
  requestId: "request-1",
  outcome: "observed",
  allocation: {
    schemaVersion:
      "crewon.desktop-plugin-project-workspace-allocation-status.v1",
    workspaceId: `workspace-project-${"b".repeat(64)}`,
    phase: "registered",
    observation: "registered",
    failureCode: null,
  },
};
test("private workspace wire snapshots bounded ticket and allocation values without roots or ownership fields", () => {
  const parsed = response(validResponse);
  assert.deepEqual(parsed, validResponse);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(
    parsed.outcome === "observed" && Object.isFrozen(parsed.allocation),
  );
  assert.deepEqual(ticket(validTicket), validTicket);
  for (const reasonCode of [
    "request_invalid",
    "ticket_unavailable",
    "deadline_exceeded",
    "allocation_unavailable",
  ]) {
    const unavailable = {
      schemaVersion: validResponse.schemaVersion,
      requestId: "request-1",
      outcome: "unavailable",
      reasonCode,
    };
    assert.deepEqual(response(unavailable), unavailable);
  }
});
test("private workspace wire refuses malformed, inherited, accessor and expanded authority payloads", () => {
  let read = false;
  for (const value of [
    null,
    [],
    { ...validTicket, root: "/tmp/other" },
    { ...validTicket, ticketId: "a".repeat(65) },
    { ...validTicket, expiresAt: "2026-02-30T00:00:00.000Z" },
    Object.create(validTicket),
    {
      ...validTicket,
      get expiresAt() {
        read = true;
        return validTicket.expiresAt;
      },
    },
  ])
    assert.throws(() => ticket(value), /wire_invalid/);
  for (const value of [
    null,
    [],
    { ...validResponse, owner: {} },
    Object.create(validResponse),
    { ...validResponse, requestId: "x".repeat(129) },
    {
      ...validResponse,
      allocation: { ...validResponse.allocation, root: "/tmp/other" },
    },
    {
      ...validResponse,
      allocation: {
        ...validResponse.allocation,
        workspaceId: "ordinary-workspace",
      },
    },
    {
      ...validResponse,
      allocation: { ...validResponse.allocation, phase: "ready" },
    },
    {
      ...validResponse,
      allocation: { ...validResponse.allocation, failureCode: "arbitrary" },
    },
    {
      ...validResponse,
      get allocation() {
        read = true;
        return validResponse.allocation;
      },
    },
    {
      schemaVersion: validResponse.schemaVersion,
      requestId: "request-1",
      outcome: "unavailable",
      reasonCode: "arbitrary",
    },
  ])
    assert.throws(() => response(value), /wire_invalid/);
  assert.equal(read, false);
});
