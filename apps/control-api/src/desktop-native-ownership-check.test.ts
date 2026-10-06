import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { validateNativeOwnership } from "./desktop-native-ownership-check.ts";
import { assertDesktopNativePluginControlConfigCurrent } from "./desktop-native-plugin-control-environment.ts";
import { assertDesktopPluginConfigurationFileCurrent } from "./desktop-plugin-configuration.ts";
import { desktopNativeMediaInputFixture } from "./desktop-native-project-media-input.test-support.ts";

const options = { skip: process.platform === "win32", timeout: 15_000 };
test(
  "coalesced ownership validation catches real file replacement before returning, then fresh scopes remain revoked",
  options,
  async (t) => {
    for (const field of ["approval", "bootstrap"] as const) {
      const f = await desktopNativeMediaInputFixture(t);
      const check =
        field === "approval"
          ? () => assertDesktopNativePluginControlConfigCurrent(f.nativeControl)
          : () => assertDesktopPluginConfigurationFileCurrent(f.bootstrap);
      const path = field === "approval" ? f.approvalPath : f.bootstrapPath;
      assert.throws(() =>
        validateNativeOwnership(() => {
          check();
          validateNativeOwnership(() => {
            const bytes = readFileSync(path);
            if (field === "approval") {
              renameSync(path, `${path}.old`);
              writeFileSync(path, bytes, { mode: 0o600 });
            } else
              writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
            check();
          });
        }),
      );
      assert.throws(() => validateNativeOwnership(check));
      assert.throws(check);
    }
  },
);

test(
  "a Native ownership scope cannot retain approval across an await or accept an async validator",
  options,
  async (t) => {
    const f = await desktopNativeMediaInputFixture(t);
    const check = () =>
      assertDesktopNativePluginControlConfigCurrent(f.nativeControl);
    validateNativeOwnership(() => {
      check();
      check();
    });
    assert.throws(
      () =>
        validateNativeOwnership(async () => {
          check();
        }),
      /must_be_synchronous/u,
    );
    await writeFile(join(dirname(f.authorityPath), "withdrawn.json"), "{}", {
      mode: 0o600,
    });
    assert.throws(() => validateNativeOwnership(check), /withdrawn/u);
  },
);
