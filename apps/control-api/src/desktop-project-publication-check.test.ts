import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { parseDesktopProjectExecutionConfiguration } from "@crewon/contracts/plugins";
import { extensionCanonicalJson } from "@crewon/domain";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { assertDesktopProjectPublications } from "./desktop-project-publication-check.ts";

test("prepared historical image queries retain exact approval checks without serializing live SQL and authorization ports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-history-startup-"));
  const store = new SqliteRunStore(join(directory, "control.sqlite"));
  try {
    await store.creativeProjectStore().migrate();
    const extensions = store.extensionStore();
    await extensions.migrate();
    await extensions.migrateProjectGenerations();
    const source = {
      pluginId: "crewon.short-drama",
      packageDigest: "sha256:" + "a".repeat(64),
      contributionId: "workbench",
    };
    const target = {
      pluginId: "crewon.comfyui-krea2",
      publisherId: "crewon",
      version: "1.0.0",
      packageDigest: "sha256:" + "b".repeat(64),
      manifestDigest: "sha256:" + "c".repeat(64),
      implementationDigest: "sha256:" + "d".repeat(64),
      contributionId: "studio",
      action: "image.query" as const,
    };
    const declared = parseDesktopProjectExecutionConfiguration(
      {
        version: "crewon.desktop-project-execution.v1",
        pluginUi: { publications: [source] },
        generationReads: { version: "crewon.project-generation-read.v1" },
        generationReadUi: { publications: [source] },
        historicalQueries: {
          version: "crewon.desktop-project-historical-query.v1",
          publications: [{ source, target }],
        },
      },
      { publications: [source] },
    );
    let authorizationCalls = 0;
    const prepared = await prepareCreativeProjects(store, {
      pluginUi: declared.pluginUi,
      generationReads: declared.generationReads,
      generationReadUi: declared.generationReadUi,
      historicalQueries: declared.historicalQueries,
      authorization: {
        authorize: async () => {
          authorizationCalls++;
          return { outcome: "deny", reasonCode: "not_invoked_by_startup" };
        },
      },
    });
    assert.ok(prepared?.historicalQueries);
    assert.throws(
      () => extensionCanonicalJson(prepared.historicalQueries),
      /extension_json_invalid/u,
    );
    assert.doesNotThrow(() =>
      assertDesktopProjectPublications(declared, prepared),
    );
    const drift = {
      ...declared,
      historicalQueries: {
        ...declared.historicalQueries!,
        publications: [
          {
            source,
            target: {
              ...target,
              implementationDigest: "sha256:" + "e".repeat(64),
            },
          },
        ],
      },
    };
    assert.throws(
      () => assertDesktopProjectPublications(drift, prepared),
      /desktop_project_execution_authority_required/u,
    );
    assert.throws(
      () => assertDesktopProjectPublications(declared, undefined),
      /desktop_project_execution_authority_required/u,
    );
    assert.equal(authorizationCalls, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
