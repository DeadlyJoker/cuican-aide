import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import type { ModelRequest } from "@crewon/agent-kernel";
import {
  createControlApiTeamOperations,
  type ControlApiClient,
} from "@crewon/control-client";
import { resolveControlTeamPlan } from "@crewon/application/team-turn";

export const teamOperations = (client: ControlApiClient) =>
  createControlApiTeamOperations(client, { preserveIdentity: true });

export const originalTask =
  "TEAM_ORIGINAL: verify the release, preserve conflicting evidence.";
export const priorContext =
  "PRIOR_CONTEXT: the release target is customer-alpha.";

export function lastUser(request: ModelRequest): string {
  return (
    request.input.items
      .filter((item) => item.type === "message" && item.role === "user")
      .map((item) => (item.type === "message" ? item.content : ""))
      .at(-1) ?? ""
  );
}

export async function completed(client: ControlApiClient, runId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { run } = await client.getRun(runId);
    if (["completed", "failed", "canceled"].includes(run.status)) return run;
    await setTimeout(10);
  }
  throw Error(`team_fixture_run_not_terminal:${runId}`);
}

export async function prepare(client: ControlApiClient, roleDirected: boolean) {
  const members = [
    { memberId: "manager", displayName: "Lead", agentVersionId: "agent-1" },
    { memberId: "qa", displayName: "QA", agentVersionId: "verifier-1" },
    {
      memberId: "security",
      displayName: "Security",
      agentVersionId: "agent-1",
    },
  ].map((member, index) => ({
    ...member,
    ...(roleDirected
      ? {
          responsibility: [
            "Own the final decision and preserve every unresolved conflict.",
            "Verify acceptance claims against reproducible test evidence.",
            "Identify security blockers and missing threat-model evidence.",
          ][index]!,
        }
      : {}),
  }));
  const { office } = await client.createOffice(
    {
      expectedRevision: 0,
      title: "Team application acceptance",
      members,
      executionTargets: members.map((member) => ({
        targetId: member.memberId,
        agentVersionId: member.agentVersionId,
      })),
    },
    "team-office",
  );
  const created = await client.createThread(
    { title: "Team main" },
    "team-main",
  );
  const history = await client.appendThreadMessage(
    created.thread.threadId,
    {
      expectedRevision: created.thread.revision,
      content: priorContext,
    },
    "prior-context",
  );
  const priorRun = await client.createRun(
    {
      threadId: created.thread.threadId,
      agentVersionId: "agent-1",
    },
    "prior-context-run",
  );
  assert.equal(
    (await completed(client, priorRun.run.runId)).status,
    "completed",
  );
  const plan = await resolveControlTeamPlan({
    client,
    threadId: created.thread.threadId,
    officeVersionId: office.officeVersionId,
    catalog: await client.getActiveAgentVersionCatalog(),
  });
  return {
    thread: (await client.getThread(history.thread.threadId)).thread,
    plan,
  };
}
