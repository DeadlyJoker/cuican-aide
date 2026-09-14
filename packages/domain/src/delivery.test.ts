import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDeliveryTargetRef,
  parseDeliveryResultRef,
  XLSX_MEDIA_TYPE,
} from "./delivery.ts";
const target = {
  schemaVersion: "crewon.delivery-target.v1",
  tenantId: "t",
  spaceId: "s",
  threadId: "thread",
  targetId: "thread-deliveries",
} as const;
test("C03 references are portable identities and reject paths, unknown versions and latest", () => {
  assert.deepEqual(parseDeliveryTargetRef(target), target);
  for (const invalid of [
    { ...target, path: "/tmp/out.xlsx" },
    { ...target, schemaVersion: "v2" },
    { ...target, threadId: "../other" },
    { ...target, targetId: "latest" },
  ])
    assert.throws(() => parseDeliveryTargetRef(invalid));
  const result = {
    schemaVersion: "crewon.delivery-result.v1",
    target,
    deliveryId: "d",
    versionId: "v",
    contentDigest: `sha256:${"a".repeat(64)}`,
    mediaType: XLSX_MEDIA_TYPE,
    sourceRunId: null,
    availability: "ready",
  };
  assert.deepEqual(parseDeliveryResultRef(result), result);
  assert.throws(() =>
    parseDeliveryResultRef({ ...result, availability: "claimed" }),
  );
  assert.throws(() =>
    parseDeliveryResultRef({ ...result, contentDigest: "filename.xlsx" }),
  );
});
