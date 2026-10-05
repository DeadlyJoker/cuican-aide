import assert from "node:assert/strict";
import test from "node:test";
import { captureCreativeProjectCompositionConfig } from "./creative-project-composition.ts";
import { prepareProjectTextPlans } from "./project-text-plan-composition.ts";
const pin = {
  pluginId: "crewon.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const approval = { publications: [pin] };
const configured = {
  authorization: { authorize: async () => ({ outcome: "allow" as const }) },
  textArtifacts: { version: "crewon.project-text.v1" },
  pluginUi: approval,
  textUi: approval,
  conversations: approval,
  textPlans: approval,
};
test("plan composition requires independent exact UI membership in all prerequisite services", () => {
  const captured = captureCreativeProjectCompositionConfig(configured)!;
  assert.deepEqual(captured.textPlans, approval);
  for (const field of ["pluginUi", "textUi", "conversations"]) {
    const v = { ...configured } as Record<string, unknown>;
    delete v[field];
    assert.throws(() => captureCreativeProjectCompositionConfig(v));
  }
  assert.throws(() =>
    captureCreativeProjectCompositionConfig({
      ...configured,
      textPlans: { publications: [{ ...pin, contributionId: "another" }] },
    }),
  );
  let getterCalls = 0;
  assert.throws(() =>
    captureCreativeProjectCompositionConfig({
      ...configured,
      get textPlans() {
        getterCalls++;
        return approval;
      },
    }),
  );
  assert.equal(getterCalls, 0);
});
test("old compositions neither open nor migrate a plan schema", async () => {
  const old = { authorization: configured.authorization };
  const captured = captureCreativeProjectCompositionConfig(old)!;
  assert.deepEqual(Object.keys(captured), ["authorization"]);
  assert.equal(typeof captured.authorization.authorize, "function");
  assert.equal(Object.hasOwn(captured, "textPlans"), false);
  let calls = 0;
  const owner = {
    projectTextPlanStore: () => {
      calls++;
      throw new Error("unexpected_plan_schema");
    },
  };
  assert.equal(
    await prepareProjectTextPlans(owner, {
      configuration: undefined,
      conversations: undefined,
    }),
    undefined,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    prepareProjectTextPlans(owner, {
      configuration: approval,
      conversations: undefined,
    }),
    /project_text_plan_composition_required/u,
  );
  assert.equal(calls, 0);
});
