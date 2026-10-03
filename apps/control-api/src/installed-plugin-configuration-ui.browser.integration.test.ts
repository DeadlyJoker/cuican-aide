import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  configurationUiBrowserFixture,
  configurationUiActor,
} from "./installed-plugin-configuration-ui.browser.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const repository = fileURLToPath(new URL("../../..", import.meta.url));
test(
  "original account/settings opens an installed business schema, saves through production BFF/Control to actual PG and reads it after settings/browser/Control reopen without executing the package",
  { skip: !connectionString, timeout: 180_000 },
  async (t) => {
    const evidenceDirectory = resolve(
      process.env.CREWON_CONFIGURATION_UI_EVIDENCE_DIRECTORY ??
        join(
          repository,
          "output/extensions/checks/installed-plugin-configuration-ui-browser",
        ),
    );
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const originalEvidence =
      process.env.CREWON_CONFIGURATION_UI_EVIDENCE_DIRECTORY;
    process.env.CREWON_CONFIGURATION_UI_EVIDENCE_DIRECTORY = evidenceDirectory;
    t.after(() => {
      if (originalEvidence === undefined)
        delete process.env.CREWON_CONFIGURATION_UI_EVIDENCE_DIRECTORY;
      else
        process.env.CREWON_CONFIGURATION_UI_EVIDENCE_DIRECTORY =
          originalEvidence;
    });
    const fixture = await configurationUiBrowserFixture(t, connectionString!);
    assert.equal(await fixture.configuration(), null);
    const value = "Actual browser named organization · 原设置配置持久化";
    const first = await fixture.runBrowser("write", value);
    const saved = await fixture.configuration();
    assert.ok(saved);
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.parameters, { organization: value });
    assert.equal(saved.createdByActorId, configurationUiActor.actorId);
    assert.deepEqual(saved.credentialBindings, []);
    await fixture.restartControl();
    const reopened = await fixture.runBrowser("read", value);
    assert.deepEqual(await fixture.configuration(), saved);
    assert.equal(
      fixture.state.browserRequests.filter(
        (request) =>
          request.method === "PUT" && request.path.endsWith("/configuration"),
      ).length,
      1,
    );
    const absence = await fixture.absence();
    assert.deepEqual(absence.creditTables, []);
    assert.ok(
      Object.values(absence.executionRows).every((count) => count === 0),
    );
    assert.equal(absence.installedNodeImports, "");
    await fixture.close();
    await writeFile(
      join(evidenceDirectory, "configuration-ui-proof.json"),
      JSON.stringify(
        {
          scope:
            "Named HTTPS identity/profile/policy + actual production BFF/Control + PG + original Web settings route",
          first,
          reopened,
          persistedConfigurationRevision: saved.revision,
          successfulConfigurationPut: fixture.state.browserRequests.filter(
            (request) => request.method === "PUT" && request.status === 200,
          ).length,
          installedState: fixture.installed.selection.state,
          ...absence,
          excludedClaims: [
            "formal Main/full App",
            "packaged.app",
            "real enterprise login",
            "Worker readiness",
            "generation",
            "personal funding/quote/settlement",
          ],
        },
        null,
        2,
      ) + "\n",
    );
  },
);
