import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
  projectPluginHttpsAuthorities,
} from "./creative-project-plugin.integration.test-support.ts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";
test(
  "production installed project conversations use original identity, HTTPS policy and PG pool1; cold metadata retain binding without execution",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
      schema = `conversation_http_${randomUUID().replaceAll("-", "")}`,
      observer = new Pool({ connectionString, max: 1 });
    const runtimes = new Set<
      Awaited<ReturnType<typeof createProductionPostgresControlApi>>
    >();
    const { source, pkg, publications } = await conversationPackage(t, {
      beforeCleanup: async () => {
        try {
          for (const runtime of runtimes) await runtime.app.close();
          runtimes.clear();
          await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await observer.end();
        }
      },
    });
    const authority = await projectPluginHttpsAuthorities(t);
    t.mock.method(globalThis, "fetch", authority.fetch);
    const ui = parseProductionPluginUiConfiguration({
      installRoot: source.installRoot,
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
      timeoutMs: 2000,
      publications: [
        {
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          packageDigest: pkg.packageDigest,
          publicAssets: ["ui.mjs"],
        },
      ],
    });
    const installation = parseProductionPluginInstallationConfiguration({
      installRoot: source.installRoot,
      sources: [(({ descriptor: _d, ...p }) => p)(pkg)],
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
      timeoutMs: 2000,
    });
    const open = async () => {
      const r = await createProductionPostgresControlApi({
        connectionString,
        schema,
        maxPoolSize: 1,
        statementTimeoutMs: 5000,
        identity: authority.identity,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        pluginInstallation: { configuration: installation },
        pluginUi: { configuration: ui },
        creativeProjects: {
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          pluginUi: { publications },
          textArtifacts: { version: "crewon.project-text.v1" },
          conversations: { publications },
        },
      });
      runtimes.add(r);
      return r;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, authority.headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const imported = await readFile(source.marker, "utf8");
    const project = await h.request(
      "POST",
      "/api/v1/creative-projects",
      { title: "原项目", briefText: "同一个项目服务" },
      "project-original",
    );
    assert.equal(project.statusCode, 200, project.body);
    const projectId = project.json().project.projectId;
    const body = {
      projectId,
      workspaceId: null,
      title: null,
      idempotencyKey: "project-conversation-original",
    };
    const invoke = (method: string, input: object) =>
      h.request("POST", `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, {
        action: `crewon.project-conversations.v1.${method}`,
        input,
      });
    const created = await invoke("createConversation", body);
    assert.equal(created.statusCode, 200, created.body);
    const binding = created.json().output.binding;
    const list = await invoke("listConversations", {
      projectId,
      afterThreadId: null,
      limit: 16,
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().output.bindings, [binding]);
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    const cold = await invoke("createConversation", body);
    assert.equal(cold.statusCode, 200, cold.body);
    assert.equal(cold.json().output.disposition, "replayed");
    assert.deepEqual(cold.json().output.binding, binding);
    const bound = await h.request(
      "GET",
      `/api/v1/threads/${binding.threadId}/project-conversation`,
    );
    assert.equal(bound.statusCode, 200, bound.body);
    assert.deepEqual(bound.json().binding, binding);
    const actor = authority.state.actor;
    authority.state.actor = { ...actor, actorId: "foreign-owner" };
    try {
      const denied = await h.request(
        "GET",
        `/api/v1/threads/${binding.threadId}/project-conversation`,
      );
      assert.equal(denied.statusCode, 403, denied.body);
    } finally {
      authority.state.actor = actor;
    }
    assert.equal(await readFile(source.marker, "utf8"), imported);
    assert.equal(
      (
        await observer.query(
          `SELECT count(*)::int n FROM "${schema}".run_snapshots`,
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await observer.query(
          `SELECT count(*)::int n FROM "${schema}".project_conversation_bindings`,
        )
      ).rows[0].n,
      1,
    );
  },
);
