import assert from "node:assert/strict";
import { textService } from "./text-ui.test-support.mjs";
const at = "2026-10-06T00:00:00.000Z",
  hash = `sha256:${"a".repeat(64)}`;
const copy = structuredClone;
/** Named public DTO ledger for actual module interaction tests; no real Thread, Run or delegation authority. */
export function textPlanUiService() {
  const base = textService();
  const saved = base.metadata.create("计划短剧", "两集都市悬疑，每集一分钟。");
  const projectId = saved.project.projectId;
  const binding = {
    bindingId: "fixture-binding",
    projectId,
    threadId: "fixture-thread",
    workspaceId: null,
    revision: 1,
    state: "active",
    source: {
      pluginId: "crewon.short-drama",
      publisherId: "example.publisher",
      version: "17.0.0",
      packageDigest: hash,
      selectionRevision: 1,
    },
    createdAt: at,
    updatedAt: at,
  };
  const calls = [],
    receipts = new Map();
  let view = null,
    loseAck = false;
  function create(input) {
    const ids = Array.from(
      { length: input.episodes?.episodeCount ?? 0 },
      (_, i) => `episode-${i + 1}`,
    );
    const kinds = [
      ...(input.start === "brief" ? ["brief"] : []),
      ...(input.start !== "script" && input.target !== "brief"
        ? ["outline"]
        : []),
      ...(input.target === "script" ? ids.map(() => "script") : []),
    ];
    return {
      plan: {
        projectId,
        planId: "fixture-plan",
        threadId: binding.threadId,
        revision: 1,
        currentPlanRevision: 1,
        state: "ready",
        activeStepId: "step-1",
        pauseReason: null,
        createdAt: at,
        updatedAt: at,
      },
      definition: {
        planId: "fixture-plan",
        planRevision: 1,
        start: input.start,
        target: input.target,
        episodeMode: input.episodes?.kind ?? "none",
        episodeIds: ids,
        adoption: input.adoption,
        instruction: input.instruction,
        sources: {
          brief: {
            briefRevision: saved.brief.briefRevision,
            contentDigest: saved.brief.contentDigest,
          },
          outline: null,
        },
      },
      steps: kinds.map((kind, i) => ({
        stepId: `step-${i + 1}`,
        ordinal: i + 1,
        kind,
        episodeId:
          kind === "script"
            ? ids[kinds.slice(0, i).filter((x) => x === "script").length]
            : null,
        attempt: 1,
        revision: 1,
        state: "ready",
        sources: null,
        run: null,
        result: null,
        selection: null,
        terminal: null,
      })),
    };
  }
  return {
    base,
    projectId,
    binding,
    calls,
    get view() {
      return view;
    },
    setView(value) {
      view = copy(value);
    },
    loseNextAck() {
      loseAck = true;
    },
    services: {
      async invoke(action, input, options) {
        if (action === "crewon.project-conversations.v1.listConversations")
          return { bindings: [copy(binding)], nextThreadId: null };
        if (action === "crewon.project-conversations.v1.openConversation")
          return { binding: copy(binding) };
        if (!action.startsWith("crewon.project-text-plans.v1."))
          return base.services.invoke(action, input, options);
        calls.push({ action, input: copy(input) });
        assert.equal(input.projectId, projectId);
        const method = action.split(".").at(-1);
        if (method === "list")
          return { plans: view ? [copy(view.plan)] : [], nextPlanId: null };
        if (method === "get") return { view: copy(view) };
        const old = receipts.get(input.idempotencyKey);
        if (old) {
          assert.deepEqual(old.input, input);
          return { ...copy(old.result), disposition: "replayed" };
        }
        if (method === "start") view = create(input);
        else {
          assert.equal(input.expectedRevision, view.plan.revision);
          assert.ok(["pause", "resume", "revoke"].includes(method));
          view = {
            ...view,
            plan: {
              ...view.plan,
              revision: view.plan.revision + 1,
              state:
                method === "pause"
                  ? "paused"
                  : method === "revoke"
                    ? "revoked"
                    : "ready",
              pauseReason: method === "pause" ? "user_paused" : null,
              activeStepId: method === "revoke" ? null : view.plan.activeStepId,
            },
          };
        }
        const result = { disposition: "committed", view: copy(view) };
        receipts.set(input.idempotencyKey, { input: copy(input), result });
        if (loseAck) {
          loseAck = false;
          throw new Error("named_lost_plan_ack");
        }
        return result;
      },
    },
  };
}
