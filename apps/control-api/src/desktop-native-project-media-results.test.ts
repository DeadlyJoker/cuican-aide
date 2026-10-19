import { repositoryFrozenPackageDirectory } from "./repository-frozen-package-directory.test-support.ts";
import { activateNativeProjectUi } from "./desktop-native-project-ui.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { loadDesktopProjectResultArchive } from "@crewon/media-runtime/desktop-project-result-archive";
import { loadDesktopProjectMaterialArchive } from "@crewon/media-runtime/desktop-project-material-archive";
import { desktopNativeMediaInputFixture } from "./desktop-native-project-media-input.test-support.ts";
import { isInstalledProjectMediaResultRuntime } from "./installed-project-media-result-runtime.ts";
const options = { skip: process.platform === "win32", timeout: 30_000 };
const fixture: typeof desktopNativeMediaInputFixture = (t, purposes, input) =>
  desktopNativeMediaInputFixture(t, purposes, {
    ...(process.env.CREWON_NATIVE_MEDIA_RESULT_TEST_PACKAGE
      ? {
          packageDirectory: process.env.CREWON_NATIVE_MEDIA_RESULT_TEST_PACKAGE,
        }
      : {}),
    ...input,
  });
test(
  "Native result scope is explicitly composed, cold reopens and never contacts generation peer for history",
  options,
  async (t) => {
    const f = await fixture(t, ["read", "write"], {
      mediaGenerations: true,
      mediaResults: ["read", "publish"],
    });
    assert.ok(
      isInstalledProjectMediaResultRuntime(f.runtime.projectMediaResults),
    );
    const url = `/api/v1/creative-projects/${f.query.projectId}/media-results`;
    const response = await f.app.inject({
      method: "GET",
      url,
      headers: f.headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      candidates: [],
      nextCandidateId: null,
    });
    const denied = await f.app.inject({
      method: "POST",
      url: url + "/no-run/0",
      headers: { ...f.headers, "x-csrf-token": "" },
      payload: {},
    });
    assert.equal(denied.statusCode, 403);
    const missing = await f.app.inject({
      method: "POST",
      url: url + "/no-run/0",
      headers: f.headers,
      payload: {},
    });
    assert.equal(missing.statusCode, 404, missing.body);
    assert.deepEqual(f.peer, []);
    await f.app.close();
    await f.runtime.close();
    const cold = await f.reopen();
    const read = await cold.app.inject({
      method: "GET",
      url,
      headers: cold.headers,
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json(), response.json());
    assert.deepEqual(f.peer, []);
  },
);
test(
  "Native history scope is absent by default and file replacement withdraws result reads",
  options,
  async (t) => {
    const absent = await fixture(t, ["read", "write"], {
      mediaGenerations: true,
    });
    assert.equal(absent.runtime.projectMediaResults, undefined);
    assert.equal(
      (
        await absent.app.inject({
          method: "GET",
          url: `/api/v1/creative-projects/${absent.query.projectId}/media-results`,
          headers: absent.headers,
        })
      ).statusCode,
      404,
    );
    const f = await fixture(t, ["read", "write"], {
      mediaGenerations: true,
      mediaResults: ["read", "publish"],
    });
    const bytes = await readFile(f.approvalPath);
    await rename(f.approvalPath, f.approvalPath + ".previous");
    await writeFile(f.approvalPath, bytes, { mode: 0o600 });
    const response = await f.app.inject({
      method: "GET",
      url: `/api/v1/creative-projects/${f.query.projectId}/media-results`,
      headers: f.headers,
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(f.peer, []);
  },
);
test(
  "result archive uses the host key but separates its path/key from upload materials and other profiles",
  options,
  async (t) => {
    const f = await fixture(t, ["read", "write"], {
      mediaGenerations: true,
      mediaResults: ["read", "publish"],
    });
    const a = loadDesktopProjectResultArchive(f.storage, f.scope),
      b = loadDesktopProjectResultArchive(f.storage, f.scope);
    const material = loadDesktopProjectMaterialArchive(f.storage, f.scope),
      other = loadDesktopProjectResultArchive(f.storage, {
        ...f.scope,
        profileId: "other-profile",
      });
    try {
      assert.deepEqual(a, b);
      assert.notEqual(a.archiveId, material.archiveId);
      assert.notEqual(a.rootDirectory, material.rootDirectory);
      assert.notDeepEqual(a.encryptionKey, material.encryptionKey);
      assert.notDeepEqual(a.encryptionKey, other.encryptionKey);
      assert.notEqual(a.rootDirectory, other.rootDirectory);
    } finally {
      for (const config of [a, b, material, other])
        config.encryptionKey.fill(0);
    }
  },
);

test(
  "Native installs Short29 and dispatches a genuine read-only result UI mount without generation",
  options,
  async (t) => {
    const f = await fixture(t, ["read", "write"], {
      packageDirectory:
        process.env.CREWON_RESULT_UI_PACKAGE_DIR ??
        repositoryFrozenPackageDirectory(
          "output/extensions/installable-plugins/short-drama-media-results-20261007/short-drama/29.0.0",
        ),
      mediaGenerations: true,
      generationFlow: true,
      mediaResults: ["read", "publish"],
    });
    const { mount } = await activateNativeProjectUi(f);
    const beforePeer = f.peer.length;
    const response = await f.runtime.ui.invokeAuthenticatedRequest!(
      f.request(),
      f.actor,
      {
        mountRef: mount.mountRef,
        action: "crewon.project-media-results.v1.listCandidates",
        input: {
          projectId: f.query.projectId,
          afterCandidateId: null,
          limit: 16,
        },
      },
      new AbortController().signal,
    );
    assert.deepEqual(response, { candidates: [], nextCandidateId: null });
    assert.equal(f.peer.length, beforePeer);
    await f.runtime.ui.closeMount(f.actor, { mountRef: mount.mountRef });
  },
);

// Asset/text-only preparation can inspect saved outputs without reference upload permission.
test(
  "Native read-only result scope works without media generation and cannot publish",
  options,
  async (t) => {
    const f = await fixture(t, ["read", "write"], { mediaResults: ["read"] });
    const url = `/api/v1/creative-projects/${f.query.projectId}/media-results`;
    const read = await f.app.inject({ method: "GET", url, headers: f.headers });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json(), { candidates: [], nextCandidateId: null });
    const write = await f.app.inject({
      method: "POST",
      url: url + "/no-run/0",
      headers: f.headers,
      payload: {},
    });
    assert.equal(write.statusCode, 403, write.body);
    assert.deepEqual(f.peer, []);
  },
);
