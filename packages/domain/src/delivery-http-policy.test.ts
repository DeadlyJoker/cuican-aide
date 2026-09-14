import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryRequestBodyLimit,
  DELIVERY_UPLOAD_BODY_BYTES,
} from "./delivery-http-policy.ts";

test("delivery upload body budget is selected only by exact POST path and a valid opaque thread identifier", () => {
  const limit = (path: string, method = "POST") =>
    deliveryRequestBodyLimit({
      method,
      url: `https://crewon.test${path}`,
      defaultLimit: 65536,
    });
  assert.equal(
    limit("/api/v1/threads/thread_1/delivery/inputs"),
    DELIVERY_UPLOAD_BODY_BYTES,
  );
  assert.equal(
    limit("/api/v1/threads/thread%3A1/delivery/inputs"),
    DELIVERY_UPLOAD_BODY_BYTES,
  );
  for (const path of [
    "/api/v1/threads/thread_1/delivery/inputs/",
    "/api/v1/threads/thread_1/delivery/inputs?",
    "/api/v1/threads/thread_1/delivery/inputs?limit=huge",
    "/api/v1/threads/thread_1/delivery/inputs#",
    "/api/v1/threads/a%2Fb/delivery/inputs",
    "/api/v1/threads/a%252Fb/delivery/inputs",
    "/api/v1/threads/thread_1/delivery/assemble",
    "/api/v1/threads/thread_1/turns",
  ])
    assert.equal(limit(path), 65536, path);
  assert.equal(limit("/api/v1/threads/thread_1/delivery/inputs", "PUT"), 65536);
});
