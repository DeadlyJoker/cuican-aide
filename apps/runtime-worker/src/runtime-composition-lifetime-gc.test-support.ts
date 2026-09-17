import {
  RuntimeCompositionLifetime,
  type RuntimeCleanupHandle,
} from "./runtime-composition-lifetime.ts";

const lifetime = new RuntimeCompositionLifetime();
const handles: RuntimeCleanupHandle[] = [],
  references: WeakRef<object>[] = [];
function add() {
  const resource = {
    bytes: Buffer.alloc(256 * 1024),
    close() {
      this.bytes.fill(0);
    },
  };
  references.push(new WeakRef(resource));
  handles.push(lifetime.own(resource, { phase: "resources" }));
}
for (let i = 0; i < 128; i++) add();
await lifetime.close();
for (let i = 0; i < 8; i++) {
  await new Promise<void>((done) => setImmediate(done));
  globalThis.gc!();
}
process.stdout.write(
  JSON.stringify({
    created: references.length,
    collected: references.filter((reference) => reference.deref() === undefined)
      .length,
    retainedHandles: handles.length,
  }),
);
// Keep the root and all completed caller handles live through the observation.
await lifetime.close();
await Promise.all(handles.map((handle) => handle.close()));
