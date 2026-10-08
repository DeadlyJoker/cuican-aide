import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationError,
  ProjectStructuredOutlineApplicationService,
  ProjectTextApplicationService,
  type ProjectStructuredOutlineApplicationDependencies,
} from "@crewon/application";
import {
  evaluateProjectOutlineQuality,
  parseProjectOutlineDocument,
  type ProjectOutlineDocument,
  type ProjectOutlineDocumentChange,
} from "@crewon/domain";
import {
  structuredOutlineFixture,
  longOutlineDocument,
  actor,
  digester,
  time,
} from "./project-structured-outline.test-support.ts";

function service(
  f: Awaited<ReturnType<typeof structuredOutlineFixture>>,
  dependencies: Partial<ProjectStructuredOutlineApplicationDependencies> = {},
) {
  return new ProjectStructuredOutlineApplicationService({
    store: f.first.text,
    projects: f.first.projects,
    foundations: f.foundations,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => time(5) },
    ids: { nextId: () => "outline-application" },
    digester,
    ...dependencies,
  });
}
function seed(document: ProjectOutlineDocument) {
  return parseProjectOutlineDocument({ ...document, beats: [], episodes: [] });
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend} Application builds 120 episodes in bounded batches, adopts actual Skill/source verified content and cold-replays one receipt`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(
          t,
          backend,
          longOutlineDocument(),
        ),
        app = service(f);
      const projectId = f.created.project.projectId,
        briefRevision = f.created.brief!.briefRevision;
      const initialize = {
        projectId,
        briefRevision,
        expectedArtifactRevision: 0,
        base: null,
        change: { kind: "initialize" as const, document: seed(f.document) },
        idempotencyKey: "init-120",
      };
      let current = await app.saveCandidate(actor, initialize);
      assert.ok(
        current.contentRevision?.schemaVersion ===
          "crewon.project-text-revision.v2",
      );
      assert.equal(
        evaluateProjectOutlineQuality(current.contentRevision.content, "full")
          .passed,
        false,
      );
      await assert.rejects(
        app.selectRevision(actor, {
          projectId,
          artifactId: current.artifact.artifactId,
          expectedArtifactRevision: current.artifact.revision,
          contentRevision: current.contentRevision.contentRevision,
          idempotencyKey: "reject-incomplete",
        }),
        (e) =>
          e instanceof ApplicationError &&
          e.category === "conflict" &&
          e.code === "project_outline_quality_failed",
      );
      let lastCommand;
      for (const collection of ["episodes", "beats"] as const) {
        for (let at = 0; at < f.document[collection].length; at += 10) {
          const change = {
            kind: "upsert",
            collection,
            items: f.document[collection].slice(at, at + 10),
            removeIds: [],
          } as ProjectOutlineDocumentChange;
          lastCommand = {
            projectId,
            briefRevision,
            expectedArtifactRevision: current.artifact.revision,
            base: {
              contentRevision: current.contentRevision!.contentRevision,
              contentDigest: current.contentRevision!.contentDigest,
            },
            change,
            idempotencyKey: `batch-${collection}-${at}`,
          };
          assert.ok(Buffer.byteLength(JSON.stringify(lastCommand)) < 60 * 1024);
          current = await app.saveCandidate(actor, lastCommand);
        }
      }
      assert.ok(
        current.contentRevision?.schemaVersion ===
          "crewon.project-text-revision.v2",
      );
      assert.deepEqual(current.contentRevision.content, f.document);
      assert.ok(
        Buffer.byteLength(JSON.stringify(current.contentRevision.content)) >
          64 * 1024,
      );
      const selection = {
        projectId,
        artifactId: current.artifact.artifactId,
        expectedArtifactRevision: current.artifact.revision,
        contentRevision: current.contentRevision.contentRevision,
        idempotencyKey: "adopt-120",
      };
      const adopted = await app.selectRevision(actor, selection);
      assert.equal(
        adopted.artifact.selectedContentRevision,
        current.contentRevision.contentRevision,
      );
      const view = await app.getOutline(actor, { projectId });
      assert.deepEqual(view!.selectedRevision, current.contentRevision);
      assert.deepEqual(view!.staleReasons, []);
      const page = await app.listRevisions(actor, {
        projectId,
        artifactId: current.artifact.artifactId,
        afterContentRevision: 0,
        limit: 2,
      });
      assert.equal(page.revisions.length, 2);
      assert.equal(page.nextContentRevision, 2);
      assert.deepEqual(
        await app.getRevision(actor, {
          projectId,
          artifactId: current.artifact.artifactId,
          contentRevision: current.contentRevision.contentRevision,
        }),
        current.contentRevision,
      );
      const count = await f.count("project_text_revisions");
      await f.first.parent.close();
      const cold = await f.open();
      const reopened = service(f, {
        store: cold.text,
        projects: cold.projects,
        foundations: cold.parent.projectFoundationStore(),
      });
      assert.equal(
        (await reopened.saveCandidate(actor, lastCommand!)).disposition,
        "replayed",
      );
      assert.equal(
        (await reopened.selectRevision(actor, selection)).disposition,
        "replayed",
      );
      assert.equal(await f.count("project_text_revisions"), count);
      assert.deepEqual(
        (await reopened.getOutline(actor, { projectId }))!.selectedRevision,
        current.contentRevision,
      );
    },
  );
  test(
    `${backend} Application keeps exact source evidence, lock semantics, CAS and actor-scoped receipts`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend),
        app = service(f);
      const projectId = f.created.project.projectId;
      const initialize = {
        projectId,
        briefRevision: f.created.brief!.briefRevision,
        expectedArtifactRevision: 0,
        base: null,
        change: { kind: "initialize" as const, document: f.document },
        idempotencyKey: "full-outline",
      };
      const saved = await app.saveCandidate(actor, initialize);
      assert.ok(
        saved.contentRevision?.schemaVersion ===
          "crewon.project-text-revision.v2",
      );
      const fake = parseProjectOutlineDocument({
        ...f.document,
        adaptation: {
          ...f.document.adaptation,
          keep: f.document.adaptation.keep.map((item, i) =>
            i === 0 ? { ...item, evidence: "原文中不存在的改编证据" } : item,
          ),
        },
      });
      assert.equal(evaluateProjectOutlineQuality(fake, "full").passed, true);
      const forged = await app.saveCandidate(actor, {
        ...initialize,
        expectedArtifactRevision: saved.artifact.revision,
        change: { kind: "initialize", document: fake },
        idempotencyKey: "fake-quote-draft",
      });
      const select = {
        projectId,
        artifactId: forged.artifact.artifactId,
        expectedArtifactRevision: forged.artifact.revision,
        contentRevision: forged.contentRevision!.contentRevision,
        idempotencyKey: "fake-adopt",
      };
      await assert.rejects(
        app.selectRevision(actor, select),
        (e) =>
          e instanceof ApplicationError &&
          e.category === "conflict" &&
          e.code === "project_outline_source_evidence_mismatch",
      );
      assert.equal(
        (await app.getOutline(actor, { projectId }))!.artifact
          .selectedContentRevision,
        null,
      );
      const adopted = await app.selectRevision(actor, {
        ...select,
        contentRevision: saved.contentRevision.contentRevision,
        idempotencyKey: "real-adopt",
      });
      const old = new ProjectTextApplicationService({
        store: f.first.text,
        projects: f.first.projects,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => time(5) },
        ids: { nextId: () => "unused" },
        digester,
      });
      const locked = await old.setLocked(actor, {
        projectId,
        artifactId: adopted.artifact.artifactId,
        expectedArtifactRevision: adopted.artifact.revision,
        locked: true,
        idempotencyKey: "lock",
      });
      const newer = await app.saveCandidate(actor, {
        ...initialize,
        expectedArtifactRevision: locked.artifact.revision,
        idempotencyKey: "candidate-while-locked",
      });
      assert.equal(newer.artifact.locked, true);
      assert.equal(
        newer.artifact.selectedContentRevision,
        saved.contentRevision.contentRevision,
      );
      await assert.rejects(
        app.selectRevision(actor, {
          ...select,
          expectedArtifactRevision: newer.artifact.revision,
          contentRevision: newer.contentRevision!.contentRevision,
          idempotencyKey: "locked-adopt",
        }),
        (e) =>
          e instanceof ApplicationError && e.code === "project_text_locked",
      );
      await assert.rejects(
        app.saveCandidate(actor, {
          ...initialize,
          expectedArtifactRevision: 0,
          idempotencyKey: "stale-cas",
        }),
        (e) =>
          e instanceof ApplicationError &&
          e.code === "project_text_revision_conflict",
      );
      await assert.rejects(
        app.saveCandidate(actor, {
          ...initialize,
          change: { kind: "initialize", document: fake },
        }),
        (e) =>
          e instanceof ApplicationError &&
          e.code === "project_text_idempotency_conflict",
      );
      await assert.rejects(
        app.getOutline({ ...actor, principalId: "foreign" }, { projectId }),
        (e) => e instanceof ApplicationError && e.category === "notFound",
      );
    },
  );
  test(
    `${backend} Application rejects oversized/ambiguous batches and rechecks live project PDP through actual commit`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend),
        app = service(f);
      const projectId = f.created.project.projectId;
      const initialize = {
        projectId,
        briefRevision: f.created.brief!.briefRevision,
        expectedArtifactRevision: 0,
        base: null,
        change: { kind: "initialize" as const, document: f.document },
        idempotencyKey: "draft",
      };
      const saved = await app.saveCandidate(actor, initialize);
      const base = {
        contentRevision: saved.contentRevision!.contentRevision,
        contentDigest: saved.contentRevision!.contentDigest,
      };
      const batch = {
        ...initialize,
        expectedArtifactRevision: saved.artifact.revision,
        base,
        change: {
          kind: "upsert" as const,
          collection: "episodes" as const,
          items: Array.from({ length: 11 }, () => f.document.episodes[0]!),
          removeIds: [],
        },
        idempotencyKey: "too-many",
      };
      await assert.rejects(
        app.saveCandidate(actor, batch),
        (e) => e instanceof ApplicationError && e.category === "validation",
      );
      await assert.rejects(
        app.saveCandidate(actor, {
          ...batch,
          change: {
            ...batch.change,
            items: [f.document.episodes[0]!],
            removeIds: [f.document.episodes[0]!.episodeId],
          },
        }),
        (e) => e instanceof ApplicationError && e.category === "validation",
      );
      await assert.rejects(
        app.saveCandidate(actor, {
          ...batch,
          base: { ...base, contentDigest: "sha256:" + "f".repeat(64) },
          change: { ...batch.change, items: [f.document.episodes[0]!] },
        }),
        (e) =>
          e instanceof ApplicationError &&
          e.code === "project_outline_base_digest_mismatch",
      );
      let checks = 0;
      const withdrawn = service(f, {
        authorization: {
          authorize: async () =>
            ++checks >= 3
              ? { outcome: "deny", reasonCode: "withdrawn" }
              : { outcome: "allow" },
        },
      });
      const before = await f.count("project_text_revisions");
      await assert.rejects(
        withdrawn.saveCandidate(actor, {
          ...initialize,
          expectedArtifactRevision: saved.artifact.revision,
          idempotencyKey: "withdrawn",
        }),
        (e) => e instanceof ApplicationError && e.category === "authorization",
      );
      assert.equal(await f.count("project_text_revisions"), before);
    },
  );
}
