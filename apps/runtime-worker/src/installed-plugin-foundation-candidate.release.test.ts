import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  extensionCanonicalJson,
  parseExtensionManifest,
  type ExtensionManifest,
} from "@crewon/domain";
import type {
  ProjectFoundationToolsMethod,
  ProjectFoundationToolsResponseMap,
  ProjectFoundationToolsTextPage,
} from "@crewon/contracts/project-foundation-tools";
import type { PublicProjectFoundation } from "@crewon/contracts/project-foundation";
import { foundationWorkerFixture } from "./installed-plugin-foundation-tools.integration.test-support.ts";
import {
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import type { RuntimeWorker } from "./runtime-worker.ts";

// Explicit release prerequisite: prepare the SDK and build Short40, then supply this directory.
// A clean checkout's ordinary tests do not depend on ignored release bytes or rebuild frozen39.
const packageDirectory =
  process.env.CREWON_TEST_SHORT_DRAMA_FOUNDATION_PLUGIN_DIR;
const configurationParameters = {
  baseUrl: "https://no-provider-request.example/",
  preset: "krea2-portrait",
};
const toolName = (operation: string) => "crewon_short_drama__" + operation;
type ParametersProjection = Readonly<{
  foundation: Omit<PublicProjectFoundation, "parameters">;
  parametersPage: ProjectFoundationToolsTextPage & Readonly<{ digest: string }>;
  projection: Readonly<{
    kind: "foundation-parameters-page";
    completeParameters: boolean;
  }>;
}>;
type ProjectionMap = Omit<
  ProjectFoundationToolsResponseMap,
  "getFoundation"
> & {
  getFoundation: ParametersProjection;
};
type Observed = Readonly<{ callId: string; output: string; value: unknown }>;
/** Resume only a persisted fairness yield, keeping the production eight-boundary budget. */
async function finishWorkerWake(worker: RuntimeWorker, runId: string) {
  for (let yields = 0; yields < 8; yields++) {
    const outcome = await worker.wake();
    if (outcome.kind !== "retried" || outcome.code !== "run_execution_yield")
      return { outcome, yields };
    assert.equal(outcome.runId, runId);
    await setTimeout(2);
  }
  throw new Error("short40_release_fairness_limit");
}
function observedValue<M extends ProjectFoundationToolsMethod>(
  observed: readonly Observed[],
  callId: string,
  _method: M,
): ProjectionMap[M] | undefined {
  return observed.find((item) => item.callId === callId)?.value as
    | ProjectionMap[M]
    | undefined;
}
function releaseManifest(): ExtensionManifest {
  assert.ok(
    packageDirectory,
    "build Short40 first and set CREWON_TEST_SHORT_DRAMA_FOUNDATION_PLUGIN_DIR",
  );
  const manifest = parseExtensionManifest(
    JSON.parse(readFileSync(join(packageDirectory, "business.json"), "utf8")),
  );
  assert.equal(manifest.schemaVersion, "crewon.extension-manifest.v2");
  assert.equal(manifest.version, "40.0.0");
  assert.equal(manifest.pluginId, "crewon.short-drama");
  assert.equal(manifest.tools.length, 32);
  return manifest;
}
function captureOutputs(
  observed: Observed[],
  items: ReadonlyArray<{ type: string; callId?: string; output?: string }>,
) {
  for (const item of items) {
    if (
      item.type !== "tool_result" ||
      !item.callId ||
      item.output === undefined
    )
      continue;
    assert.ok(
      Buffer.byteLength(item.output) <= 9999,
      `whole model fragment ${item.callId} is bounded`,
    );
    const wrapper = JSON.parse(item.output) as { resultJsonParts: string[] };
    assert.deepEqual(Object.keys(wrapper), ["resultJsonParts"]);
    assert.ok(Array.isArray(wrapper.resultJsonParts));
    assert.ok(
      wrapper.resultJsonParts.every((part) => typeof part === "string"),
    );
    if (!observed.some((value) => value.callId === item.callId))
      observed.push({
        callId: item.callId,
        output: item.output,
        value: JSON.parse(wrapper.resultJsonParts.join("")),
      });
  }
}
function allToolsTransport(
  manifest: ExtensionManifest,
  observed: Observed[],
): ModelTransportPort {
  return {
    adapterName: "actual-short40-release-no-network-model",
    adapterVersion: "1",
    modelId: "named-release-model",
    async *stream(request) {
      assert.deepEqual(
        request.tools
          .filter((tool) => tool.name.startsWith("crewon_short_drama__"))
          .map((tool) => tool.name)
          .sort(),
        manifest.tools.map((tool) => toolName(tool.operationId)).sort(),
      );
      captureOutputs(observed, request.input.items);
      const scope = observedValue(observed, "scope", "readScope")?.scope;
      const parameterPages = observed.filter((item) =>
        item.callId.startsWith("parameters-"),
      );
      const lastParameters = parameterPages.at(-1)?.value as
        | ParametersProjection
        | undefined;
      let next: readonly [string, string, unknown] | undefined;
      if (!scope) next = ["scope", "foundation_scope", {}];
      else if (
        !lastParameters ||
        lastParameters.parametersPage.nextOffset !== null
      ) {
        const startOffset = lastParameters?.parametersPage.nextOffset ?? 0;
        next = [
          `parameters-${startOffset}`,
          "foundation_read",
          {
            projectId: scope.projectId,
            parametersStartOffset: startOffset,
            parametersLimit: 1024,
          },
        ];
      } else {
        const source = {
          projectId: scope.projectId,
          sourceRevision: scope.source?.revision,
          sourceDigest: scope.source?.digest,
        };
        const saved = observedValue(observed, "save", "saveProposal")?.proposal;
        const steps = [
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
              projectId: scope.projectId,
              expectedFoundationRevision: scope.foundationRevision,
              expectedProposalRevision: 0,
              kind: "novel-adaptation",
              text: "雨夜重逢。保留人物与冲突，请用户确认后再继续分集。",
            },
          ],
          [
            "proposal",
            "foundation_proposal",
            {
              projectId: scope.projectId,
              proposalRevision: saved?.revision,
              proposalDigest: saved?.contentDigest,
              startOffset: 0,
              limit: 1024,
            },
          ],
          [
            "history",
            "foundation_proposals",
            { projectId: scope.projectId, afterProposalRevision: 0, limit: 4 },
          ],
        ] as const;
        next = steps.find(
          ([callId]) => !observed.some((item) => item.callId === callId),
        );
      }
      if (next)
        yield {
          type: "tool.call",
          kind: "function",
          callId: next[0],
          name: toolName(next[1]),
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

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual Short40 release bytes dispatch all eight Foundation tools through the original Run and cold committed-receipt replay`,
    {
      timeout: 120000,
      skip:
        !packageDirectory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      const manifest = releaseManifest(),
        observed: Observed[] = [];
      const f = await foundationWorkerFixture(
        t,
        () => allToolsTransport(manifest, observed),
        {
          backend,
          packageDirectory,
          configurationParameters,
          maxToolRounds: 32,
        },
      );
      assert.deepEqual(f.entry.registration.manifest, manifest);
      assert.equal(f.entry.registration.identity.version, "40.0.0");
      t.diagnostic(
        `actual Short40 packageDigest=${f.entry.registration.identity.packageDigest}`,
      );
      assert.equal(
        f.entry.registration.manifest.tools.filter(
          (tool) => tool.adapterId === "crewon.project-foundation-tools",
        ).length,
        8,
      );
      const accepted = await f.start();
      const admission = await f.store
        .projectFoundationRunStore()
        .loadFoundationRunAdmission({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          runId: accepted.result.binding.runId,
        });
      assert.ok(admission);
      assert.equal(
        admission.installation.packageDigest,
        f.entry.registration.identity.packageDigest,
      );
      assert.equal(
        admission.projectStageAdmissionDigest,
        accepted.stageAdmission.contentDigest,
      );
      const first = await f.openWorker({
        afterToolProviderResolved: async (resolution) => {
          if ("result" in resolution && resolution.result?.callId === "save")
            throw new Error("named_short40_candidate_result_loss");
        },
      });
      const interrupted = await finishWorkerWake(
        first.worker,
        accepted.result.binding.runId,
      );
      assert.ok(interrupted.yields > 0);
      assert.deepEqual(interrupted.outcome, {
        kind: "retried",
        runId: accepted.result.binding.runId,
        code: "named_short40_candidate_result_loss",
      });
      const query = {
        projectId: f.created.project.projectId,
        afterProposalRevision: 0,
        limit: 4,
      };
      const committed = await f.app.listProposals(actor, query);
      assert.equal(committed.proposals.length, 1);
      const before = await f.app.getFoundation(actor, {
        projectId: query.projectId,
      });
      assert.ok(before);
      assert.equal(before.revision, 1);
      assert.equal(before.confirmedProposal, null);
      await f.closeWorker();
      const cold = await f.openWorker();
      const resumed = await finishWorkerWake(
        cold.worker,
        accepted.result.binding.runId,
      );
      assert.equal(resumed.outcome.kind, "completed", JSON.stringify(resumed));
      await f.closeWorker();
      assert.deepEqual(await f.app.listProposals(actor, query), committed);
      const parameters = observed
        .filter((item) => item.callId.startsWith("parameters-"))
        .map((item) => item.value as ParametersProjection);
      assert.ok(parameters.length > 1);
      const canonicalParameters = extensionCanonicalJson(before.parameters);
      assert.equal(
        parameters.map((item) => item.parametersPage.content).join(""),
        canonicalParameters,
      );
      assert.ok(Buffer.byteLength(canonicalParameters) > 7500);
      let offset = 0;
      for (const page of parameters) {
        assert.equal(Object.hasOwn(page.foundation, "parameters"), false);
        assert.equal(page.parametersPage.startOffset, offset);
        assert.equal(
          page.parametersPage.digest,
          digester.sha256(canonicalParameters),
        );
        assert.ok(Array.from(page.parametersPage.content).length <= 1024);
        offset = page.parametersPage.endOffset;
      }
      assert.equal(parameters.at(-1)!.parametersPage.nextOffset, null);
      assert.equal(offset, Array.from(canonicalParameters).length);
      assert.equal(
        observedValue(observed, "save", "saveProposal")!.disposition,
        "replayed",
      );
      assert.equal(
        observedValue(observed, "save", "saveProposal")!.foundationRevision,
        1,
      );
      assert.equal(
        observedValue(observed, "page", "readSourcePage")!.page.content,
        "雨😀夜\n重逢 café。",
      );
      assert.equal(
        observedValue(observed, "chapters-first", "listSourceChapters")!
          .chapters.length,
        2,
      );
      assert.equal(
        observedValue(observed, "chapters-zero", "listSourceChapters")!.chapters
          .length,
        1,
      );
      assert.ok(
        observedValue(observed, "chapters-zero", "listSourceChapters")!
          .chapters[0]!.startOffset > 0,
      );
      assert.equal(
        observedValue(observed, "proposal", "getProposal")!.page!.content,
        committed.proposals[0]!.text,
      );
      assert.equal(
        observedValue(observed, "history", "listProposals")!.proposals.length,
        1,
      );
      assert.equal(
        Object.hasOwn(
          observedValue(observed, "history", "listProposals")!.proposals[0]!,
          "text",
        ),
        false,
      );
      assert.equal(
        (await f.app.getFoundation(actor, { projectId: query.projectId }))!
          .revision,
        1,
      );
      assert.ok(
        observed.every((item) => Buffer.byteLength(item.output) <= 9999),
      );
      const events = await f.store.listRunEvents(
        accepted.result.binding,
        0,
        1000,
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "model.output.delta")
          .map((event) => event.data.delta),
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
      // Separate trusted host Application call represents the user's later confirmation, never a Node grant.
      const confirmed = await f.app.confirmProposal(actor, {
        projectId: query.projectId,
        expectedFoundationRevision: 1,
        proposalRevision: 1,
        proposalDigest: committed.proposals[0]!.contentDigest,
        idempotencyKey: "short40-later-manual-confirmation",
      });
      assert.equal(confirmed.foundation.revision, 2);
      assert.deepEqual(confirmed.foundation.confirmedProposal, {
        revision: 1,
        digest: committed.proposals[0]!.contentDigest,
      });
    },
  );

  test(
    `${backend}: actual Short40 keeps an original v0 discussion readable and rejects Foundation tools without independent admission`,
    {
      timeout: 120000,
      skip:
        !packageDirectory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      const manifest = releaseManifest();
      let projectId = "",
        legacyRead = false;
      const transport = (): ModelTransportPort => ({
        adapterName: "actual-short40-legacy-no-network-model",
        adapterVersion: "1",
        modelId: "named-legacy-release-model",
        async *stream(request) {
          assert.deepEqual(
            request.tools
              .filter((tool) => tool.name.startsWith("crewon_short_drama__"))
              .map((tool) => tool.name)
              .sort(),
            manifest.tools.map((tool) => toolName(tool.operationId)).sort(),
          );
          const previous = request.input.items.find(
            (item) =>
              item.type === "tool_result" &&
              item.callId === "original-v0-scope",
          );
          if (!previous || previous.type !== "tool_result")
            yield {
              type: "tool.call",
              kind: "function",
              callId: "original-v0-scope",
              name: toolName("project_context_read"),
              input: "{}",
            };
          else {
            const value = JSON.parse(
              JSON.parse(previous.output).resultJson,
            ) as {
              scope: {
                projectId: string;
                stage: { kind: string };
                allowedOperations: string[];
              };
            };
            assert.equal(value.scope.projectId, projectId);
            assert.equal(value.scope.stage.kind, "discussion");
            assert.equal(
              value.scope.allowedOperations.includes(
                "foundation_proposal_save",
              ),
              false,
            );
            legacyRead = true;
            yield {
              type: "tool.call",
              kind: "function",
              callId: "new-foundation-denied",
              name: toolName("foundation_scope"),
              input: "{}",
            };
          }
          yield { type: "completed", checkpoint: null };
        },
      });
      const f = await foundationWorkerFixture(t, transport, {
        backend,
        packageDirectory,
        configurationParameters,
        projectKind: "legacy-v0",
        configured: false,
      });
      projectId = f.created.project.projectId;
      assert.equal(await f.app.getFoundation(actor, { projectId }), null);
      const accepted = await f.start();
      assert.equal(
        await f.store.projectFoundationRunStore().loadFoundationRunAdmission({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          runId: accepted.result.binding.runId,
        }),
        null,
      );
      const worker = await f.openWorker();
      const result = await worker.worker.wake();
      assert.equal(result.kind, "retried");
      if (result.kind === "retried")
        assert.match(result.code, /foundation_services_unavailable/u);
      assert.equal(legacyRead, true);
      assert.equal(f.checks, 0);
      assert.equal(
        (
          await f.app.listProposals(actor, {
            projectId,
            afterProposalRevision: 0,
            limit: 4,
          })
        ).proposals.length,
        0,
      );
    },
  );
}
