import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "@crewon/control-client";
import { mediaInputControlFixture } from "./project-media-input.test-support.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: public options read the current reviewed installation/configuration without executing media`,
    options,
    async (t) => {
      const f = await mediaInputControlFixture(t, backend);
      const url = f.root.replace(/media-inputs$/, "media-input-options");
      const response = await f.app.inject({
        method: "GET",
        url,
        headers: f.headers(),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), {
        configuration: {
          revision: f.target.configuration.revision,
          workflows: [
            "krea2-reference-four-view",
            "flux2-three-reference-storyboard",
          ],
        },
      });
      const limited = await createInstalledPluginTaskRuntimeCore({
        ...f.input,
        projectMediaInputs: { ...f.configuration, reviews: [f.reviews[0]!] },
      });
      try {
        const value = await limited.projectMediaInputs!.getOptions(
          {
            method: "GET",
            url,
            remoteAddress: "127.0.0.1",
            headers: f.headers(),
          },
          f.actor,
          { projectId: f.query.projectId },
        );
        assert.deepEqual(value.configuration?.workflows, [
          "krea2-reference-four-view",
        ]);
      } finally {
        await limited.close();
      }
      await f.parent
        .pluginInstallationStore()
        .commitSelection(
          selectionRecipe(f.target.selection, "disable-options-target", {
            actor: f.actor,
            state: "disabled",
          }),
        );
      const disabled = await f.app.inject({
        method: "GET",
        url,
        headers: f.headers(),
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.deepEqual(disabled.json(), { configuration: null });
      await f.noExecution();
    },
  );
  test(
    `${backend}: options keep original identity, read purpose, profile and bounded query checks`,
    options,
    async (t) => {
      const f = await mediaInputControlFixture(t, backend);
      const url = f.root.replace(/media-inputs$/, "media-input-options");
      const read = (headers = f.headers(), suffix = "") =>
        f.app.inject({ method: "GET", url: url + suffix, headers });
      assert.equal(
        (await read({ ...f.headers(), authorization: "" })).statusCode,
        401,
      );
      for (const account of [1, 2, 3])
        assert.ok((await read(f.headers("read", account))).statusCode >= 400);
      assert.equal(
        (await read(f.headers(), "?packageDigest=foreign")).statusCode,
        400,
      );
      f.mediaPolicy.read = false;
      assert.equal((await read()).statusCode, 403);
      f.mediaPolicy.read = true;
      f.state.installationAllowed = false;
      assert.equal((await read()).statusCode, 403);
      f.state.installationAllowed = true;
      f.state.configurationAllowed = false;
      assert.equal((await read()).statusCode, 403);
      f.state.configurationAllowed = true;
      f.controlState.beforeConfiguration = async () => {
        f.controlState.profileId = "changed-profile";
      };
      assert.equal(
        (await read()).statusCode,
        403,
        f.controlState.errors.join("\n"),
      );
      await f.noExecution();
    },
  );
  test(
    `${backend}: options discard selection drift and late read withdrawal after configuration I/O`,
    options,
    async (t) => {
      const f = await mediaInputControlFixture(t, backend);
      const url = f.root.replace(/media-inputs$/, "media-input-options");
      f.controlState.beforeConfiguration = async () => {
        f.controlState.beforeConfiguration = undefined;
        await f.parent
          .pluginInstallationStore()
          .commitSelection(
            selectionRecipe(f.target.selection, "drift-options-target", {
              actor: f.actor,
              state: "disabled",
            }),
          );
      };
      const drift = await f.app.inject({
        method: "GET",
        url,
        headers: f.headers(),
      });
      assert.equal(drift.statusCode, 409, drift.body);
      f.controlState.beforeConfiguration = async () => {
        f.mediaPolicy.read = false;
      };
      const withdrawn = await f.app.inject({
        method: "GET",
        url,
        headers: f.headers(),
      });
      assert.equal(withdrawn.statusCode, 403, withdrawn.body);
      await f.noExecution();
    },
  );
}
test("original ControlClient discovers options through actual loopback HTTP", async (t) => {
  const f = await mediaInputControlFixture(t, "sqlite");
  const baseUrl = await f.app.listen({ host: "127.0.0.1", port: 0 }),
    h = f.headers();
  const client = new ControlApiClient({
    baseUrl,
    accessToken: h.authorization.slice(7),
    csrfToken: h["x-csrf-token"],
    origin: h.origin,
  });
  const result = await client.projectMediaInputs.getOptions({
    projectId: f.query.projectId,
  });
  assert.equal(result.configuration?.revision, f.target.configuration.revision);
  assert.deepEqual(result.configuration?.workflows, [
    "krea2-reference-four-view",
    "flux2-three-reference-storyboard",
  ]);
  await f.noExecution();
});
