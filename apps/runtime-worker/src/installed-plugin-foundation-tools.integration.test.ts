import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  type PublicProjectFoundationRunScope,
} from "@crewon/contracts/project-foundation-tools";
import {
  foundationFixtureManifest,
  foundationWorkerFixture,
} from "./installed-plugin-foundation-tools.integration.test-support.ts";
import { actor } from "./installed-plugin-business-execution.integration.test-support.ts";
const name = (op: string) => "example_professional__" + op;
type Observed = { callId: string; value: any };
function allOperationsTransport(observed: Observed[]): ModelTransportPort {
  return {
    adapterName: "foundation-eight-op-no-network-model",
    adapterVersion: "1",
    modelId: "named-foundation-fixture",
    async *stream(request) {
      assert.deepEqual(
        request.tools
          .filter((t) => t.name.startsWith("example_professional__"))
          .map((t) => t.name)
          .sort(),
        PROJECT_FOUNDATION_TOOL_OPERATION_IDS.map(name).sort(),
      );
      for (const item of request.input.items.filter(
        (i) => i.type === "tool_result",
      )) {
        const outer = JSON.parse(item.output),
          value = JSON.parse(outer.value);
        if (!observed.some((v) => v.callId === item.callId))
          observed.push({ callId: item.callId, value });
      }
      const scope = observed.find((v) => v.callId === "scope")?.value.scope as
        | PublicProjectFoundationRunScope
        | undefined;
      const source = {
        projectId: scope?.projectId,
        sourceRevision: scope?.source?.revision,
        sourceDigest: scope?.source?.digest,
      };
      const saved = observed.find((v) => v.callId === "save")?.value.proposal;
      const steps = [
        ["scope", "foundation_scope", {}],
        ["foundation", "foundation_read", { projectId: scope?.projectId }],
        ["source", "foundation_source", source],
        [
          "page",
          "foundation_source_page",
          { ...source, startOffset: 0, limit: 1024 },
        ],
        ["chapters-first", "foundation_chapters", { ...source, limit: 16 }],
        [
          "chapters-zero",
          "foundation_chapters",
          { ...source, afterStartOffset: 0, limit: 16 },
        ],
        [
          "save",
          "foundation_proposal_save",
          {
            projectId: scope?.projectId,
            expectedFoundationRevision: scope?.foundationRevision,
            expectedProposalRevision: 0,
            kind: "novel-adaptation",
            text: "雨夜重逢。保留人物与冲突，请用户确认后再继续分集。",
          },
        ],
        [
          "proposal",
          "foundation_proposal",
          {
            projectId: scope?.projectId,
            proposalRevision: saved?.revision,
            proposalDigest: saved?.contentDigest,
            startOffset: 0,
            limit: 1024,
          },
        ],
        [
          "history",
          "foundation_proposals",
          { projectId: scope?.projectId, afterProposalRevision: 0, limit: 4 },
        ],
      ] as const;
      const next = steps.find(([id]) => !observed.some((v) => v.callId === id));
      if (next)
        yield {
          type: "tool.call",
          kind: "function",
          callId: next[0],
          name: name(next[1]),
          input: JSON.stringify(next[2]),
        };
      else {
        yield { type: "output.delta", delta: "候选方案已保存，" };
        yield { type: "output.delta", delta: "请你手动确认。" };
      }
      yield { type: "completed", checkpoint: null };
    },
  };
}
test(
  "sqlite: original installed RuntimeResolver dispatches eight Foundation tools, resumes a lost candidate receipt and streams bounded results",
  { timeout: 60000 },
  async (t) => {
    const observed: Observed[] = [];
    const f = await foundationWorkerFixture(t, () =>
      allOperationsTransport(observed),
    );
    assert.equal(foundationFixtureManifest.tools.length, 8);
    const chapters = foundationFixtureManifest.tools.find(
      (t) => t.operationId === "foundation_chapters",
    )!;
    assert.equal(chapters.inputSchema.type, "object");
    if (chapters.inputSchema.type === "object")
      assert.equal(
        chapters.inputSchema.required.includes("afterStartOffset"),
        false,
      );
    const accepted = await f.start();
    const scope = await f.store
      .projectFoundationRunStore()
      .loadFoundationRunAdmission({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: accepted.result.binding.runId,
      });
    assert.ok(scope);
    assert.equal(
      scope.projectStageAdmissionDigest,
      accepted.stageAdmission.contentDigest,
    );
    assert.equal(
      (accepted.stageAdmission.allowedOperations as readonly string[]).includes(
        "foundation_proposal_save",
      ),
      false,
    );
    const first = await f.openWorker({
      afterToolProviderResolved: async (resolution) => {
        if ("result" in resolution && resolution.result?.callId === "save")
          throw new Error("named_foundation_candidate_result_loss");
      },
    });
    const interrupted = await first.worker.wake();
    assert.deepEqual(interrupted, {
      kind: "retried",
      runId: accepted.result.binding.runId,
      code: "named_foundation_candidate_result_loss",
    });
    const query = {
      projectId: f.created.project.projectId,
      afterProposalRevision: 0,
      limit: 4,
    };
    const before = await f.app.listProposals(actor, query);
    assert.equal(before.proposals.length, 1);
    assert.equal(
      (await f.app.getFoundation(actor, { projectId: query.projectId }))!
        .revision,
      1,
    );
    await f.closeWorker();
    const cold = await f.openWorker();
    const resumed = await cold.worker.wake();
    assert.equal(
      resumed.kind,
      "completed",
      JSON.stringify({ resumed, observed }),
    );
    await f.closeWorker();
    assert.equal(observed.length, 9);
    const get = (id: string) => observed.find((v) => v.callId === id)!.value;
    assert.ok(Buffer.byteLength(JSON.stringify(get("foundation"))) > 8192);
    assert.ok(Buffer.byteLength(JSON.stringify(get("foundation"))) <= 32768);
    assert.equal(get("page").page.content, "雨😀夜\n重逢 café。");
    assert.equal(get("chapters-first").chapters.length, 2);
    assert.equal(get("chapters-first").chapters[0].startOffset, 0);
    assert.equal(get("chapters-zero").chapters.length, 1);
    assert.ok(get("chapters-zero").chapters[0].startOffset > 0);
    assert.equal(get("save").disposition, "replayed");
    assert.equal(get("save").foundationRevision, 1);
    assert.equal(Object.hasOwn(get("save").proposal, "text"), false);
    assert.equal(get("proposal").page.content, before.proposals[0]!.text);
    assert.equal(get("history").proposals.length, 1);
    assert.equal(Object.hasOwn(get("history").proposals[0], "text"), false);
    assert.equal(
      (await f.app.getFoundation(actor, { projectId: query.projectId }))!
        .confirmedProposal,
      null,
    );
    assert.deepEqual(await f.app.listProposals(actor, query), before);
    const events = await f.store.listRunEvents(
      accepted.result.binding,
      0,
      1000,
    );
    assert.deepEqual(
      events
        .filter((e) => e.type === "model.output.delta")
        .map((e) => e.data.delta),
      ["候选方案已保存，", "请你手动确认。"],
    );
    assert.deepEqual(
      await f.store.listRunEvents(
        accepted.result.binding,
        events[0]!.sequence,
        1000,
      ),
      events.slice(1),
    );
    assert.ok(f.checks > 8);
  },
);
function scopeOnlyTransport(): ModelTransportPort {
  return {
    adapterName: "foundation-denial-no-network-model",
    adapterVersion: "1",
    modelId: "named-denial-fixture",
    async *stream(request) {
      if (!request.input.items.some((i) => i.type === "tool_result"))
        yield {
          type: "tool.call",
          kind: "function",
          callId: "scope-only",
          name: name("foundation_scope"),
          input: "{}",
        };
      else yield { type: "output.delta", delta: "unavailable" };
      yield { type: "completed", checkpoint: null };
    },
  };
}
test(
  "sqlite: old project.write does not supply an independent Foundation deployment",
  { timeout: 60000 },
  async (t) => {
    const f = await foundationWorkerFixture(t, scopeOnlyTransport, {
      configured: false,
    });
    await f.start();
    const worker = await f.openWorker();
    const result = await worker.worker.wake();
    assert.equal(result.kind, "retried");
    if (result.kind === "retried")
      assert.match(result.code, /foundation_services_unavailable/u);
    assert.equal(
      (
        await f.app.listProposals(actor, {
          projectId: f.created.project.projectId,
          afterProposalRevision: 0,
          limit: 4,
        })
      ).proposals.length,
      0,
    );
    assert.equal(await f.count("run_snapshots"), 1);
    assert.equal(f.checks, 0);
  },
);
test(
  "sqlite: a genuine installed dispatch still refuses an independently withdrawn Foundation service permission",
  { timeout: 60000 },
  async (t) => {
    const f = await foundationWorkerFixture(t, scopeOnlyTransport);
    await f.start();
    f.denyFoundation();
    const worker = await f.openWorker();
    const result = await worker.worker.wake();
    assert.equal(result.kind, "retried");
    if (result.kind === "retried")
      assert.match(result.code, /foundation_permission_denied/u);
    assert.ok(f.checks > 0);
    assert.equal(
      (
        await f.app.listProposals(actor, {
          projectId: f.created.project.projectId,
          afterProposalRevision: 0,
          limit: 4,
        })
      ).proposals.length,
      0,
    );
  },
);
test(
  "sqlite: absent complete sidecar namespace cannot downgrade Foundation operations to the legacy discussion grant",
  { timeout: 60000 },
  async (t) => {
    const f = await foundationWorkerFixture(t, scopeOnlyTransport);
    const accepted = await f.start();
    const db = new DatabaseSync(f.databasePath);
    try {
      db.exec(
        "DROP TABLE project_foundation_run_requirements; DROP TABLE project_foundation_run_admissions; DROP TABLE project_foundation_run_schema_version;",
      );
    } finally {
      db.close();
    }
    const worker = await f.openWorker();
    const result = await worker.worker.wake();
    assert.equal(result.kind, "retried");
    if (result.kind === "retried")
      assert.match(result.code, /foundation_services_unavailable/u);
    assert.equal(
      await f.store.projectFoundationRunStore().loadFoundationRunAdmission({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: accepted.result.binding.runId,
      }),
      null,
    );
    assert.equal(
      (
        await f.app.listProposals(actor, {
          projectId: f.created.project.projectId,
          afterProposalRevision: 0,
          limit: 4,
        })
      ).proposals.length,
      0,
    );
  },
);
