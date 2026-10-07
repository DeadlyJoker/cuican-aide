import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { loadDesktopProjectResultArchive } from "@crewon/media-runtime/desktop-project-result-archive";
import { loadDesktopProjectMaterialArchive } from "@crewon/media-runtime/desktop-project-material-archive";
import { desktopNativeMediaInputFixture as fixture } from "./desktop-native-project-media-input.test-support.ts";
import { isInstalledProjectMediaResultRuntime } from "./installed-project-media-result-runtime.ts";
const options = { skip: process.platform === "win32", timeout: 30_000 };
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
