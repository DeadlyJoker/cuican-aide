import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_PLUGIN_COMPOSITION_VERSION,
  parseDesktopPluginCompositionConfiguration as parse,
} from "./desktop-plugin-composition-configuration.ts";

test("Native composition opt-in has an exact version and no service identity or permission fields", () => {
  const value = parse({ version: DESKTOP_PLUGIN_COMPOSITION_VERSION });
  assert.deepEqual(value, { version: DESKTOP_PLUGIN_COMPOSITION_VERSION });
  assert.ok(Object.isFrozen(value));
  let reads = 0;
  for (const invalid of [
    null,
    {},
    { version: "crewon.desktop-plugin-composition.v2" },
    { version: DESKTOP_PLUGIN_COMPOSITION_VERSION, implementationRevision: 99 },
    { version: DESKTOP_PLUGIN_COMPOSITION_VERSION, authorityEpoch: "forged" },
    {
      get version() {
        reads++;
        return DESKTOP_PLUGIN_COMPOSITION_VERSION;
      },
    },
  ])
    assert.throws(() => parse(invalid), /desktop_plugin_composition_invalid/u);
  assert.equal(reads, 0);
});
