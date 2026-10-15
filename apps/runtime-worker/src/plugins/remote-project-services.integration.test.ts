import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteProjectServices } from "./remote-project-services.ts";
import { composeInstalledPluginProjectFoundationToolsDependencies } from "./installed-plugin-project-foundation-tools.ts";
import { foundationToolsOwnerFixture } from "./project-foundation-tools-service-owner.test-support.ts";
import { foundationMetadataFixture } from "../../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
import {
  namespaceColumns,
  namespaceValues,
} from "../../../../packages/store/src/plugin-project-workspace-store-support.ts";
import { PLUGIN_PROJECT_WORKSPACE_TABLE } from "../../../../packages/store/src/plugin-project-workspace-schema.ts";
import { parsePluginProjectWorkspaceNamespace } from "@crewon/domain";
const literal = (v: unknown) => "'" + String(v).replaceAll("'", "''") + "'";

test(
  "PostgreSQL remote Foundation deployment saves through the actual Run/receipt/namespace, cold replays once, then refuses withdrawn service",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    // Real Run, checked Worker dispatch, SQL ownership and commit. PDP below is a named host fixture, not a live model.
    const f = await foundationToolsOwnerFixture(t, "creative", "postgres");
    const metadata = await foundationMetadataFixture(t, {
      backend: "postgres",
      schema: f.schema!,
      prefix: f.prefix,
      path: f.databasePath,
    });
    await metadata.migrate();
    const ownerScope = {
      ...f.actor,
      profileId: f.taskAdmission.profileId,
      pluginId: f.taskAdmission.pluginId,
      publisherId: f.taskAdmission.publisherId,
    };
    await metadata.mark(f.admission.projectId, ownerScope);
    await f.parent.migratePluginProjectWorkspaceNamespaces();
    const namespace = parsePluginProjectWorkspaceNamespace({
      schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
      owner: { ...ownerScope, projectId: f.admission.projectId },
      workspaceId: f.stage.workspaceId,
      createdAt: new Date().toISOString(),
    });
    await f.sql(
      `INSERT INTO ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}(${namespaceColumns}) VALUES(${namespaceValues(namespace).map(literal).join(",")})`,
    );
    let allowed = true;
    const requests: unknown[] = [];
    const services = createRemoteProjectServices(async (body, signal) => {
      signal?.throwIfAborted();
      requests.push(body);
      return { outcome: allowed ? "allow" : "deny" };
    });
    const d = composeInstalledPluginProjectFoundationToolsDependencies({
      store: f.parent,
      config: services.projectFoundationTools!,
      resolveActor: f.dependencies.resolveActor,
    });
    const create = () =>
      f.owner({
        ...d,
        authorizeFoundationService: (s) =>
          d.authorizeService(f.taskAdmission, s),
      });
    const first = create(),
      request = {
        projectId: f.admission.projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "creative-plan" as const,
        text: "真实 PostgreSQL 远程服务创作方案，等待用户确认。",
      };
    const op = await f.prepare("saveProposal", request);
    const result = await f.invoke(first, op, (command) =>
      f.service(first).saveProposal({ command, request }),
    );
    assert.equal(result.disposition, "committed");
    assert.equal(result.proposal.revision, 1);
    await first.close();
    const cold = create();
    const replay = await f.invoke(
      cold,
      op,
      (command) => f.service(cold).saveProposal({ command, request }),
      { method: "reconcile" },
    );
    assert.equal(replay.disposition, "replayed");
    assert.deepEqual(replay.proposal, result.proposal);
    assert.ok(
      requests.some((body) => (body as { kind?: string }).kind === "service"),
    );
    assert.ok(
      requests.some(
        (body) => (body as { kind?: string }).kind === "permission",
      ),
    );
    allowed = false;
    await assert.rejects(
      f.invoke(cold, op, (command) =>
        f.service(cold).saveProposal({ command, request }),
      ),
    );
    await cold.close();
  },
);
