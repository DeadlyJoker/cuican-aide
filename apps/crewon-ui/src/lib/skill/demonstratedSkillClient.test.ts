import { describe, expect, it, vi } from "vitest";
import {
  createDemonstratedSkillClient,
  type SkillExecutionInput,
} from "./demonstratedSkillClient";

describe("demonstrated Skill transport", () => {
  it("preserves fixed version identity and optimistic revision through the authenticated transport", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createDemonstratedSkillClient(request);
    const version = {
      skillId: "skill/a",
      versionId: "v1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    };
    await client.activate("skill/a", 7, version);
    expect(request).toHaveBeenCalledWith("/api/v1/skills/skill%2Fa/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, version }),
    });
  });

  it("propagates host denials without a local activation fallback", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "skill_trial_required" }), {
          status: 409,
        }),
    );
    await expect(
      createDemonstratedSkillClient(request).createVersion("skill", 1),
    ).rejects.toThrow("skill_trial_required");
  });

  it.each([undefined, "requestApproval", "approveForMe"] as const)(
    "preserves optional task permission mode %s outside the immutable invocation",
    async (toolPermissionMode) => {
      const request = vi.fn(
        async (_path: string, _init?: RequestInit) =>
          new Response(null, { status: 204 }),
      );
      const input: SkillExecutionInput = {
        executionId: "execution-1",
        purpose: "execute",
        threadId: "thread-1",
        expectedThreadRevision: 3,
        agentVersionId: null,
        invocation: {
          schemaVersion: "crewon.skill-invocation.v1",
          skill: {
            skillId: "skill-1",
            versionId: "v1",
            contentDigest: `sha256:${"a".repeat(64)}`,
          },
          parameters: {},
          requiredToolRefs: [],
        },
        ...(toolPermissionMode === undefined ? {} : { toolPermissionMode }),
      };
      await createDemonstratedSkillClient(request).startExecution(
        "skill-1",
        input,
      );
      const [path, init] = request.mock.calls[0];
      expect(path).toBe("/api/v1/skills/skill-1/executions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual(input);
      expect(body.invocation).not.toHaveProperty("toolPermissionMode");
      if (toolPermissionMode === undefined)
        expect(body).not.toHaveProperty("toolPermissionMode");
    },
  );
});
