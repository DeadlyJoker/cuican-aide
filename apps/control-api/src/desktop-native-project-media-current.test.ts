import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import test from "node:test";
import type { ActorContext } from "@crewon/application";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { nativeMediaFlowFixture } from "./desktop-native-project-media-flow.test-support.ts";

for (const change of ["withdraw", "close"] as const)
  test(
    `Native media rejects ${change} after the original profile read, before source I/O or Run admission`,
    { skip: process.platform === "win32", timeout: 30_000 },
    async (t) => {
      const f = await nativeMediaFlowFixture(t, {
        packageDirectory: process.env.CREWON_MEDIA_GENERATION_PACKAGE_DIR,
      });
      const original = DesktopPluginAuthority.prototype.profile;
      let changed = false;
      t.mock.method(
        DesktopPluginAuthority.prototype,
        "profile",
        async function (this: DesktopPluginAuthority, actor: ActorContext) {
          const scope = await original.call(this, actor);
          if (!changed) {
            changed = true;
            if (change === "withdraw")
              await writeFile(
                join(dirname(f.authorityPath), "withdrawn.json"),
                "{}",
                {
                  mode: 0o600,
                },
              );
            else this.close();
          }
          return scope;
        },
      );
      const response = await f.post();
      assert.ok(changed);
      assert.equal(
        response.statusCode,
        change === "withdraw" ? 500 : 403,
        response.body,
      );
      if (change === "withdraw")
        assert.match(
          inspect(f.routeState.errors),
          /installed_plugin_native_authority_withdrawn/u,
        );
      assert.equal(f.provider.state.sourceGets, 0);
      assert.equal(f.provider.state.uploads, 0);
      assert.equal(f.routeState.wakes, 0);
      const db = new DatabaseSync(f.databasePath, { readOnly: true });
      try {
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM run_snapshots").get()!.n,
          1,
        );
        assert.equal(
          db
            .prepare("SELECT COUNT(*) AS n FROM project_media_generation_links")
            .get()!.n,
          0,
        );
      } finally {
        db.close();
      }
    },
  );
