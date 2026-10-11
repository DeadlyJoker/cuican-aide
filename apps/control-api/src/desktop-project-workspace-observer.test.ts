import assert from "node:assert/strict";
import test from "node:test";
import { captureDesktopProjectWorkspaceObserver as capture } from "./desktop-project-workspace-observer.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";

for (const field of [
  "desktopNativeProjectWorkspaceObserver",
  "nativeWorkspaceObserver",
] as const)
  test(`${field} captures only an explicit owned-project observer without invoking it`, () => {
    let called = false;
    const observe = async () => {
      called = true;
      throw new Error("unexpected_observation");
    };
    assert.equal(capture({}, field, undefined), undefined);
    assert.equal(capture({ [field]: undefined }, field, undefined), undefined);
    assert.equal(
      capture({ [field]: observe }, field, "plugin-project-v1"),
      observe,
    );
    assert.throws(() => capture({ [field]: observe }, field, undefined));
    assert.throws(() => capture({ [field]: {} }, field, "plugin-project-v1"));
    assert.throws(() =>
      capture(Object.create({ [field]: observe }), field, "plugin-project-v1"),
    );
    assert.throws(() =>
      capture(
        Object.defineProperty({}, field, {
          enumerable: true,
          get() {
            called = true;
            return observe;
          },
        }),
        field,
        "plugin-project-v1",
      ),
    );
    assert.throws(() =>
      capture(
        Object.defineProperty({}, field, { value: observe }),
        field,
        "plugin-project-v1",
      ),
    );
    assert.equal(called, false);
  });

test("actual Desktop composer rejects an inherited Native observer before store acquisition", async () => {
  let read = false;
  const dependencies = Object.create({
    nativeWorkspaceObserver: async () => {},
  });
  Object.defineProperty(dependencies, "store", {
    get() {
      read = true;
      throw new Error("unexpected_store_acquisition");
    },
  });
  await assert.rejects(
    createDesktopPluginRuntime(
      {} as Parameters<typeof createDesktopPluginRuntime>[0],
      dependencies,
    ),
    /project_conversation_native_provisioning_invalid/,
  );
  assert.equal(read, false);
});
