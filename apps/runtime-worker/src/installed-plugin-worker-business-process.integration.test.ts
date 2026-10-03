import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { professionalProviderFixture } from "./installed-plugin-ui-business-execution.provider.test-support.ts";
import { prepareInstalledProcessTasks } from "./installed-plugin-worker-admission.test-support.ts";
import {
  installedProcessActor as actor,
  installedProcessCompletion,
  installedWorkerProcessFixture,
} from "./installed-plugin-worker-process.test-support.ts";
import {
  installedProcessBusinessRows,
  prepareInstalledWorkerRelease,
} from "./installed-plugin-worker-release.test-support.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const packages = ["1.0.0", "2.0.0"].map(
  (version) =>
    process.env[
      version === "1.0.0"
        ? "CREWON_TEST_BUSINESS_PLUGIN_V1_DIR"
        : "CREWON_TEST_BUSINESS_PLUGIN_V2_DIR"
    ] ??
    join(
      root,
      "output/extensions/installable-plugins/installed-worker-report-20261003",
      version,
    ),
);
const missing = packages.some((directory) => !existsSync(directory));
const options = {
  timeout: 60_000,
  skip: missing
    ? "actual outside-built professional-report v1/v2 packages are required"
    : false,
};

test(
  "formal main executes actual fixture-funded old and current packages through HTTPS authority and preserves the original default Agent",
  options,
  async (t) => {
    const provider = await professionalProviderFixture(t);
    const fixture = await installedWorkerProcessFixture(t);
    const release = fixture.start("release");
    assert.equal(
      (await installedProcessCompletion(release)).code,
      0,
      release.stderr(),
    );
    const { document } = await prepareInstalledWorkerRelease(
      fixture,
      packages,
      {
        organization: "Actual process fixture company",
        providerBaseUrl: `${provider.baseUrl}/`,
      },
    );
    const { admitted, original, quotes } = await prepareInstalledProcessTasks(
      fixture,
      document,
    );
    assert.equal(
      quotes,
      2,
      "only the explicit test admission setup supplies quotes",
    );
    const before = installedProcessBusinessRows(fixture.databasePath);
    assert.equal(before.plugin_credit_reservations, 2);
    const expectedRuns = [
      ...admitted.map((task) => task.binding.runId),
      original.runState.runId,
    ];
    for (const runId of expectedRuns) {
      const worker = fixture.start("worker", {
        CREWON_CONTROL_SECURITY_MODE: "production",
        CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
      });
      assert.equal(
        (await installedProcessCompletion(worker)).code,
        0,
        worker.stderr(),
      );
      assert.deepEqual(JSON.parse(worker.stdout()), {
        kind: "completed",
        runId,
      });
    }
    const idle = fixture.start("worker", {
      CREWON_CONTROL_SECURITY_MODE: "production",
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
    });
    assert.equal(
      (await installedProcessCompletion(idle)).code,
      0,
      idle.stderr(),
    );
    assert.deepEqual(JSON.parse(idle.stdout()), { kind: "idle" });
    assert.deepEqual(
      installedProcessBusinessRows(fixture.databasePath),
      before,
      "startup and execution do not create additional admissions, grants, or reservations",
    );
    const posts = provider
      .requests()
      .filter((request) => request.method === "POST");
    assert.equal(posts.length, 2);
    assert.deepEqual(
      posts.map((request) => JSON.parse(request.body!).pluginVersion),
      ["1.0.0", "2.0.0"],
    );
    assert.deepEqual(
      provider
        .reports()
        .map((report) => report.pluginVersion)
        .sort(),
      ["1.0.0", "2.0.0"],
    );
    assert.equal(
      fixture.modelRequests.length,
      5,
      "each installed Run uses one tool turn and one result turn; the default uses one text turn",
    );
    const ordinary = fixture.modelRequests.filter(
      (request) =>
        !(request.tools as { name: string }[]).some(
          (tool) => tool.name === "example_professional__generate",
        ),
    );
    assert.equal(ordinary.length, 1);
    assert.deepEqual(
      new Set(
        (ordinary[0]!.tools as { name: string }[]).map((tool) => tool.name),
      ),
      new Set(["get_goal", "create_goal", "update_plan"]),
    );
    for (const route of ["/actor", "/policy", "/package"])
      assert.ok(
        fixture.authorityRequests.some((request) => request.path === route),
      );
    const store = new SqliteRunStore(fixture.databasePath);
    try {
      for (const [index, accepted] of admitted.entries()) {
        assert.equal(
          (await store.loadRunInSpace(accepted.binding))?.status,
          "completed",
        );
        const persisted = await store
          .extensionStore()
          .loadExtensionRunBinding(accepted.binding);
        assert.deepEqual(persisted?.target, document.entries[index]!.target);
        const admission = await store
          .extensionStore()
          .loadPluginTaskAdmission(accepted.binding);
        assert.equal(
          admission?.packageDigest,
          document.entries[index]!.packageIdentity.packageDigest,
        );
        assert.equal(admission?.version, index === 0 ? "1.0.0" : "2.0.0");
        assert.equal(admission?.principalId, actor.principalId);
        const messages = await store.listMessages(accepted.binding, 0, 100);
        assert.match(
          JSON.stringify(messages.at(-1)?.content),
          new RegExp(
            `answer:professional:${index + 1}\\.0\\.0:Actual process fixture company`,
            "u",
          ),
        );
      }
      assert.equal(
        (
          await store.loadRunInSpace({
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            runId: original.runState.runId,
          })
        )?.status,
        "completed",
      );
    } finally {
      await store.close();
    }
  },
);

for (const refusal of [
  "policy revoked",
  "principal mismatch",
  "package revoked",
] as const) {
  test(
    `formal main refuses an existing fixture-funded installed Run on ${refusal} before model or supplier dispatch`,
    options,
    async (t) => {
      const provider = await professionalProviderFixture(t);
      const fixture = await installedWorkerProcessFixture(t);
      const release = fixture.start("release");
      assert.equal(
        (await installedProcessCompletion(release)).code,
        0,
        release.stderr(),
      );
      const { document } = await prepareInstalledWorkerRelease(
        fixture,
        packages,
        {
          organization: "Actual denial fixture",
          providerBaseUrl: `${provider.baseUrl}/`,
        },
      );
      const { admitted } = await prepareInstalledProcessTasks(
        fixture,
        document,
        1,
      );
      if (refusal === "policy revoked") fixture.denyExecution();
      else if (refusal === "principal mismatch") fixture.returnWrongPrincipal();
      else fixture.denyPackageExecution();
      const worker = fixture.start("worker", {
        CREWON_CONTROL_SECURITY_MODE: "production",
        CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: fixture.configPath,
      });
      assert.equal(
        (await installedProcessCompletion(worker)).code,
        0,
        worker.stderr(),
      );
      assert.notEqual(
        (JSON.parse(worker.stdout()) as { kind: string }).kind,
        "completed",
      );
      assert.equal(fixture.modelRequests.length, 0);
      assert.equal(provider.requests().length, 0);
      assert.ok(
        fixture.authorityRequests.some(({ path }) => path === "/actor"),
      );
      if (refusal === "policy revoked")
        assert.ok(
          fixture.authorityRequests.some(({ path }) => path === "/policy"),
        );
      if (refusal === "package revoked")
        assert.ok(
          fixture.authorityRequests.some(
            ({ path, body }) =>
              path === "/package" && body.purpose === "submit",
          ),
        );
      const store = new SqliteRunStore(fixture.databasePath);
      try {
        assert.notEqual(
          (await store.loadRunInSpace(admitted[0]!.binding))?.status,
          "completed",
        );
        assert.equal(
          (
            await store
              .extensionStore()
              .loadPluginTaskAdmission(admitted[0]!.binding)
          )?.packageDigest,
          document.entries[0]!.packageIdentity.packageDigest,
        );
      } finally {
        await store.close();
      }
    },
  );
}
