import assert from "node:assert/strict";
import test from "node:test";
import { captureProjectConversationNativeProvisioning as capture } from "./project-conversation-native-provisioning.ts";
test("Native conversation provisioning is explicit and captures trusted methods without evaluating getters", () => {
  assert.equal(capture(undefined, undefined), undefined);
  let read = false;
  const valid = {
    observe: async () => ({
      version: "crewon.plugin-project-workspace-native-observation.v1" as const,
    }),
    registration: {
      async recordFromNativeObservation() {
        throw new Error("not called during capture");
      },
    },
  };
  assert.ok(Object.isFrozen(capture(valid, "plugin-project-v1")));
  assert.throws(() => capture(valid, undefined), /native_provisioning_invalid/);
  assert.throws(
    () =>
      capture(
        {
          ...valid,
          get observe() {
            read = true;
            return valid.observe;
          },
        },
        "plugin-project-v1",
      ),
    /native_provisioning_invalid/,
  );
  assert.throws(
    () =>
      capture(
        {
          ...valid,
          registration: {
            get recordFromNativeObservation() {
              read = true;
              return valid.registration.recordFromNativeObservation;
            },
          },
        },
        "plugin-project-v1",
      ),
    /native_provisioning_invalid/,
  );
  assert.throws(
    () => capture(Object.create(valid), "plugin-project-v1"),
    /native_provisioning_invalid/,
  );
  assert.throws(
    () => capture({ ...valid, owner: {} } as typeof valid, "plugin-project-v1"),
    /native_provisioning_invalid/,
  );
  assert.equal(read, false);
});
