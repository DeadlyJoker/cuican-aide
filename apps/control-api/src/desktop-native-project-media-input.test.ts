import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { desktopNativeMediaInputFixture } from "./desktop-native-project-media-input.test-support.ts";
import { assertInstalledPluginTaskRuntimeCoreBinding } from "./installed-plugin-task-runtime-core.ts";
import { assertDesktopNativeProjectMediaInputDeclaration } from "./desktop-native-project-media-input-composition.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";
const options = { skip: process.platform === "win32", timeout: 25_000 };
test(
  "Native exact-byte UI declaration composes original metadata request dispatch independently, without execution or fabricated mount",
  options,
  async (t) => {
    for (const mediaInputUi of [false, true]) {
      const f = await desktopNativeMediaInputFixture(t, ["read", "write"], {
        mediaInputUi,
      });
      assert.equal(
        Object.hasOwn(f.startup.creativeProjects!, "mediaInputUi"),
        false,
      );
      await assert.rejects(
        async () =>
          f.runtime.ui.invokeAuthenticatedRequest!(
            f.request(),
            f.actor,
            {
              mountRef: "m".repeat(40),
              action: "crewon.project-media-inputs.v1.loadInput",
              input: f.query,
            },
            new AbortController().signal,
          ),
        {
          code: mediaInputUi
            ? "plugin_ui_mount_unavailable"
            : "project_media_input_ui_unavailable",
        },
      );
      assert.equal(f.runtime.tasks!.projectGenerations, undefined);
      assert.deepEqual(f.peer, []);
    }
  },
);
test(
  "native original Main identity and file-issued Core expose explicit media metadata without ambient execution",
  options,
  async (t) => {
    const f = await desktopNativeMediaInputFixture(t);
    assertInstalledPluginTaskRuntimeCoreBinding(f.runtime.tasks!, {
      store: f.parent,
      requests: f.runtime.configuration.requests,
    });
    assert.equal(
      Object.hasOwn(f.startup.creativeProjects!, "mediaInputs"),
      false,
    );
    assert.equal(f.runtime.tasks!.projectGenerations, undefined);
    await assert.rejects(
      createDesktopPluginRuntime(
        { configuration: f.bootstrap },
        {
          store: f.parent,
          identity: f.identity,
          clock: { now: () => new Date().toISOString() },
          digester: {
            sha256: (bytes) =>
              `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
          creativeProjects: f.prepared,
        },
      ),
      /desktop_native_project_media_input_authority_required/u,
    );
    for (const suffix of ["", "?inputRevision=1"]) {
      const response = await f.app.inject({
        method: "GET",
        url: `${f.request().url}/${f.query.mediaInputId}${suffix}`,
        headers: f.headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { state: null });
    }
    assert.deepEqual(f.peer, []);
  },
);
test(
  "native read-only purpose cannot save; an allowed write still requires real adopted source and target",
  options,
  async (t) => {
    for (const purposes of [["read"], ["read", "write"]] as const) {
      const f = await desktopNativeMediaInputFixture(t, purposes);
      const result = await f.app.inject({
        method: "POST",
        url: f.request().url,
        headers: { ...f.headers, "idempotency-key": "native-explicit-purpose" },
        payload: f.command,
      });
      assert.equal(
        result.statusCode,
        purposes.length === 1 ? 403 : 409,
        result.body,
      );
      const read = await f.app.inject({
        method: "GET",
        url: `${f.request().url}/${f.query.mediaInputId}`,
        headers: f.headers,
      });
      assert.equal(read.statusCode, 200, read.body);
      assert.deepEqual(f.peer, []);
    }
  },
);
test(
  "native owner close and actual DB cold reopen produce a new original request scope and retain project metadata",
  options,
  async (t) => {
    const f = await desktopNativeMediaInputFixture(t);
    const original = f.runtime.tasks!.projectMediaInputs!;
    await f.app.close();
    await f.runtime.close();
    assert.throws(() => original.loadInput(f.request(), f.actor, f.query));
    const next = await f.reopen();
    assert.notEqual(next.parent, f.parent);
    assert.notEqual(
      next.runtime.configuration.requests,
      f.runtime.configuration.requests,
    );
    const result = await next.app.inject({
      method: "GET",
      url: `${next.request().url}/${f.query.mediaInputId}`,
      headers: next.headers,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { state: null });
    const loaded = await next.prepared!.service.getProject(f.actor, {
      projectId: f.query.projectId,
    });
    assert.equal(loaded!.title, f.project.project.title);
    assert.deepEqual(f.peer, []);
  },
);
test(
  "native metadata refuses copied declarations, exact-byte approval replacement and withdrawn Main authority",
  options,
  async (t) => {
    for (const change of ["approval", "withdrawal"] as const) {
      const f = await desktopNativeMediaInputFixture(t);
      assert.throws(() =>
        assertDesktopNativeProjectMediaInputDeclaration({
          configuration: { ...f.bootstrap },
          nativeControl: f.nativeControl,
        }),
      );
      if (change === "approval") {
        const bytes = await readFile(f.approvalPath);
        await rename(f.approvalPath, `${f.approvalPath}.old`);
        await writeFile(f.approvalPath, bytes, { mode: 0o600 });
      } else
        await writeFile(
          join(dirname(f.authorityPath), "withdrawn.json"),
          "{}",
          { mode: 0o600 },
        );
      const response = await f.app.inject({
        method: "GET",
        url: `${f.request().url}/${f.query.mediaInputId}`,
        headers: f.headers,
      });
      assert.notEqual(response.statusCode, 200);
      assert.deepEqual(f.peer, []);
    }
  },
);
test(
  "a metadata package digest cannot authorize a different prepared business manifest",
  options,
  async (t) => {
    await assert.rejects(
      desktopNativeMediaInputFixture(t, ["read", "write"], {
        reviewIdentityFixture: "different-manifest",
      }),
      /desktop_native_project_media_input_declaration_invalid/u,
    );
  },
);
