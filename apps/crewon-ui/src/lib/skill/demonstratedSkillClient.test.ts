import { describe, expect, it, vi } from "vitest";
import { createDemonstratedSkillClient } from "./demonstratedSkillClient";

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
});
