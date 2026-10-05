import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
  projectPluginHttpsAuthorities,
} from "./creative-project-plugin.integration.test-support.ts";
import {
  exerciseColdTextRecovery,
  textRecoveryAcknowledgementLoss,
} from "./project-text-recovery-plugin.integration.test-support.ts";

test(
  "production cold text recovery uses original installed mount/HTTPS authority and PostgreSQL maxPoolSize1, never a Node task",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const schema = `text_recovery_${randomUUID().replaceAll("-", "")}`;
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const observer = new Pool({ connectionString, max: 1 });
    const runtimes = new Set<
      Awaited<ReturnType<typeof createProductionPostgresControlApi>>
    >();
    const source = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        try {
          for (const runtime of runtimes) await runtime.app.close();
          await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await observer.end();
        }
      },
    });
    const authority = await projectPluginHttpsAuthorities(t);
    t.mock.method(globalThis, "fetch", authority.fetch);
    const loss = textRecoveryAcknowledgementLoss(t);
    let peers = 0;
    t.mock.method(InstalledPluginPeerClient.prototype, "prepare", async () => {
      peers++;
      throw new Error("text_recovery_must_not_prepare_node");
    });
    const requirements = [
      "crewon.creative-projects",
      "crewon.project-texts",
      "crewon.project-text-recovery",
    ].map((service) => ({ service, apiVersion: "1", optional: false }));
    const pkg = await source.source("recovery", {
      pluginId: "test.production-recovery",
      uiOnly: true,
      requires: requirements,
    });
    const other = await source.source("other", {
      pluginId: "test.production-other-recovery",
      uiOnly: true,
      requires: requirements,
    });
    const publications = [pkg, other].map((p) => ({
      pluginId: p.pluginId,
      packageDigest: p.packageDigest,
      contributionId: "workbench",
    }));
    const ui = parseProductionPluginUiConfiguration({
      installRoot: source.installRoot,
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
      timeoutMs: 2000,
      publications: [pkg, other].map((p) => ({
        pluginId: p.pluginId,
        publisherId: p.publisherId,
        packageDigest: p.packageDigest,
        publicAssets: ["ui.mjs"],
      })),
    });
    const installation = parseProductionPluginInstallationConfiguration({
      ...source.configuration([pkg, other]),
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
    });
    let denyProject = false;
    let legacy = 0;
    const open = async () => {
      const runtime = await createProductionPostgresControlApi({
        connectionString,
        schema,
        maxPoolSize: 1,
        statementTimeoutMs: 5000,
        identity: authority.identity,
        authorization: {
          authorize: async () => {
            legacy++;
            return { outcome: "deny", reasonCode: "unused_legacy" };
          },
        },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        pluginInstallation: { configuration: installation },
        pluginUi: { configuration: ui },
        creativeProjects: {
          authorization: {
            authorize: async () =>
              denyProject
                ? { outcome: "deny", reasonCode: "project_recovery_denied" }
                : { outcome: "allow" },
          },
          pluginUi: { publications },
          textArtifacts: { version: "crewon.project-text.v1" },
          textUi: { publications },
          textRecovery: { publications },
        },
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, authority.headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    await h.install(other);
    await h.enable(other);
    const result = await exerciseColdTextRecovery({
      h,
      lease: () => lease,
      loss,
      reopen: async () => {
        await runtime.app.close();
        runtimes.delete(runtime);
        runtime = await open();
        lease = await h.mount(pkg, 2);
      },
      assertOtherActorDenied: async (projectId, intentId, expectedRevision) => {
        const different = await h.mount(other, 2);
        const differentPath = `/api/v1/plugins/ui/mounts/${different.mountRef}/actions`;
        const hidden = await h.request("POST", differentPath, {
          action: "crewon.project-text-recovery.v1.getPending",
          input: { projectId },
        });
        assert.equal(hidden.statusCode, 200, hidden.body);
        assert.equal(hidden.json().output.intent, null);
        const stolen = await h.request("POST", differentPath, {
          action: "crewon.project-text-recovery.v1.acknowledge",
          input: { projectId, intentId, expectedRevision },
        });
        assert.ok([404, 409].includes(stolen.statusCode), stolen.body);
        const originalActor = authority.state.actor;
        authority.state.actor = {
          ...originalActor,
          actorId: "other-actor-same-principal",
        };
        try {
          const foreignLease = await h.mount(pkg, 2);
          const originalProject = await h.invoke(
            foreignLease,
            "crewon.creative-projects.v1.getProject",
            { projectId },
          );
          assert.equal(originalProject.project.projectId, projectId);
          const path = `/api/v1/plugins/ui/mounts/${foreignLease.mountRef}/actions`;
          const read = await h.request("POST", path, {
            action: "crewon.project-text-recovery.v1.getPending",
            input: { projectId },
          });
          assert.equal(read.statusCode, 200, read.body);
          assert.equal(read.json().output.intent, null);
          const ack = await h.request("POST", path, {
            action: "crewon.project-text-recovery.v1.acknowledge",
            input: { projectId, intentId, expectedRevision },
          });
          assert.ok([404, 409].includes(ack.statusCode), ack.body);
        } finally {
          authority.state.actor = originalActor;
        }
      },
    });
    const action = {
      action: "crewon.project-text-recovery.v1.getPending",
      input: { projectId: result.projectId },
    };
    denyProject = true;
    const denied = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      action,
    );
    assert.equal(denied.statusCode, 403, denied.body);
    denyProject = false;
    authority.state.deny = true;
    const uiRevoked = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      action,
    );
    assert.equal(uiRevoked.statusCode, 403, uiRevoked.body);
    authority.state.deny = false;
    const count = await observer.query(
      `SELECT count(*) n FROM "${schema}".project_text_mutation_receipts`,
    );
    assert.equal(Number(count.rows[0].n), 4);
    for (const table of [
      "runs",
      "external_operations",
      "extension_run_bindings",
      "plugin_task_credit_admissions",
      "plugin_task_unmetered_admissions",
      "project_generation_links",
    ]) {
      const present = await observer.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
        [schema, table],
      );
      if (present.rowCount)
        assert.equal(
          Number(
            (
              await observer.query(
                `SELECT count(*) n FROM "${schema}"."${table}"`,
              )
            ).rows[0].n,
          ),
          0,
        );
    }
    assert.equal(existsSync(source.marker), false);
    assert.equal(peers, 0);
    assert.equal(legacy, 0);
    const disabled = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        expectedSelectionRevision: 2,
        state: "disabled",
        selectedPackageDigest: pkg.packageDigest,
      },
      "disable-recovery",
    );
    assert.equal(disabled.statusCode, 200, disabled.body);
    const after = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      action,
    );
    assert.ok([403, 409].includes(after.statusCode), after.body);
    t.diagnostic(
      "actual single PostgreSQL parent connection; original HTTP/HTTPS actors/profile/UI PDP+Project PDP; real COMMIT/ACK loss/cold recovery/same-key/ACK; zero peer/Run/funds/provider",
    );
  },
);
