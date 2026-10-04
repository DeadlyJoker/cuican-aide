import assert from "node:assert/strict";
import test from "node:test";
import { pluginInstallationOpaqueId, extensionOpaqueId } from "@crewon/domain";
import type { ApplicationIdKind } from "@crewon/application";
import { createPluginTaskApplicationIds } from "./plugin-task-application-ids.ts";

for (const [firstByte, leadingCharacter] of [
  [0xf8, "-"],
  [0xfc, "_"],
] as const)
  test(`persisted plugin task IDs preserve all 32 entropy bytes when base64url begins with ${leadingCharacter}`, () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    bytes[0] = firstByte;
    const encoded = Buffer.from(bytes).toString("base64url");
    assert.equal(encoded[0], leadingCharacter);
    const requests: number[] = [];
    const generator = createPluginTaskApplicationIds({
      randomBytes(size) {
        requests.push(size);
        return bytes;
      },
    });
    const kinds: ApplicationIdKind[] = [
      "run",
      "message",
      "threadEvent",
      "runEvent",
      "modelHistoryItem",
      "outboxMessage",
      "workItem",
    ];
    for (const kind of kinds) {
      const id = generator.nextId(kind);
      assert.equal(id, `plugin-${encoded}`);
      assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u);
      assert.equal(extensionOpaqueId(id), id);
      assert.equal(pluginInstallationOpaqueId(id), id);
      assert.deepEqual(
        Buffer.from(id.slice("plugin-".length), "base64url"),
        Buffer.from(bytes),
      );
    }
    assert.deepEqual(
      requests,
      kinds.map(() => 32),
    );
    assert.ok(Object.isFrozen(generator));
  });

test("each task identity receives fresh full-size entropy and malformed entropy is rejected", () => {
  let calls = 0;
  const generator = createPluginTaskApplicationIds({
    randomBytes(size) {
      assert.equal(size, 32);
      return new Uint8Array(size).fill(++calls);
    },
  });
  assert.notEqual(generator.nextId("run"), generator.nextId("message"));
  for (const size of [0, 31, 33])
    assert.throws(
      () =>
        createPluginTaskApplicationIds({
          randomBytes: () => new Uint8Array(size),
        }).nextId("run"),
      /plugin_task_application_id_entropy_invalid/u,
    );
});
