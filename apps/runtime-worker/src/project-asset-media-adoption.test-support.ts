import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import type { TestContext } from "node:test";
import {
  CreativeProjectApplicationService,
  ProjectAssetApplicationService,
  type ProjectAssetMediaAdoptionAuthority,
  type ProjectAssetMediaAdoptionRequest,
} from "@crewon/application";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import { mediaResultFixture } from "./project-media-result-publisher.test-support.ts";

/** Original installed handler, saved candidate, encrypted bytes and SQL. Commit/PDP callbacks are named fixtures. */
export async function assetMediaAdoptionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: { migrate?: boolean } = {},
) {
  const f = await mediaResultFixture(t, backend),
    old = await f.referenceSource(),
    candidate = (
      await f.publisher.publish(f.actor, f.query, {
        signal: new AbortController().signal,
      })
    ).candidate,
    at = "2026-10-07T12:00:00.000Z",
    write = {
      request: {
        actor: f.actor,
        query: {
          ...f.query,
          candidateId: candidate.candidateId,
          candidateDigest: candidate.contentDigest,
          assetId: old.asset.assetId,
          expectedAssetRevision: old.asset.revision,
          assetContentRevision: old.content.contentRevision,
          idempotencyKey: "adopt-original-media-result",
        },
      },
      at,
    },
    state = { active: true, currentCalls: 0, transactionCalls: 0 };
  const authority = (
    request: ProjectAssetMediaAdoptionRequest = write.request,
  ): ProjectAssetMediaAdoptionAuthority => ({
    version: "crewon.project-asset-media-adoption-commit.v1",
    request,
    assertCurrent: async () => {
      state.currentCalls++;
      if (!state.active) throw new Error("named_adoption_inactive");
    },
    assertTransactionCurrent: async () => {
      state.transactionCalls++;
      if (!state.active) throw new Error("named_adoption_inactive");
    },
    assertActive: () => {
      if (!state.active) throw new Error("named_adoption_inactive");
    },
  });
  if (options.migrate !== false) await f.store.migrateAssetAdoptions();
  const common = {
      authorization: { authorize: async () => ({ outcome: "allow" as const }) },
      clock: { now: () => at },
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
    },
    assets = new ProjectAssetApplicationService({
      ...common,
      store: f.parent.projectAssetStore({ verifier: selectionVerifier }),
      projects: f.parent.creativeProjectStore(),
      texts: f.parent.projectTextStore(),
    }),
    projects = new CreativeProjectApplicationService({
      ...common,
      store: f.parent.creativeProjectStore(),
    });
  async function receipts() {
    const sql = `SELECT count(*) AS n FROM ${f.prefix}project_asset_media_adoption_receipts`;
    if (backend === "sqlite") {
      const db = new DatabaseSync(f.databasePath, { readOnly: true });
      try {
        return Number(db.prepare(sql).get()!.n);
      } finally {
        db.close();
      }
    }
    const c = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await c.connect();
    try {
      return Number((await c.query(sql)).rows[0].n);
    } finally {
      await c.end();
    }
  }
  return {
    ...f,
    old,
    candidate,
    at,
    write,
    adoptionState: state,
    adoptionAuthority: authority,
    assets,
    projects,
    receipts,
    adopt: () => f.store.adoptAssetReference(write, authority()),
  };
}
