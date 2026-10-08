import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  projectSourceUploadPartPath,
} from "@crewon/contracts/project-source-uploads";
import {
  boundedPluginProxyRequest,
  boundedPluginSourceUploadPartRequest,
  boundedPluginProxyResponse,
  pluginProxyPolicy,
} from "./plugin-proxy-policy.ts";

const origin = "https://source-upload-bff.example.test";
const mount = "mount_" + "a".repeat(32);
const path = projectSourceUploadPartPath(mount, {
  uploadId: "original-upload",
  partIndex: 0,
  rawDigest: `sha256:${"a".repeat(64)}`,
});
function policy(target = path, method = "PUT") {
  const query = target.indexOf("?");
  return pluginProxyPolicy({
    pathname: query < 0 ? target : target.slice(0, query),
    search: query < 0 ? "" : target.slice(query),
    method,
  });
}
function request(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  method = "PUT",
) {
  return new Request(origin + path, {
    method,
    headers: { "content-type": "application/octet-stream", ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}

test("mounted source part policy allows only the exact canonical PUT and retains old JSON route DTOs", () => {
  assert.deepEqual(policy(), {
    outcome: "allow",
    responseKind: "json",
    responseMaxBytes: MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
    requestKind: "sourceUploadPart",
  });
  assert.deepEqual(
    policy(`/api/v1/plugins/ui/mounts/${mount}/actions`, "POST"),
    {
      outcome: "allow",
      responseKind: "json",
      responseMaxBytes: 128 * 1024,
    },
  );
  for (const method of [
    "GET",
    "POST",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "CONNECT",
  ])
    assert.deepEqual(policy(path, method), {
      outcome: "deny",
      status: 405,
      code: "method_not_allowed",
    });
  for (const query of [
    "?",
    "?tenantId=foreign",
    "?partIndex=1",
    "?limit=1",
    "?rawDigest=forged",
  ])
    assert.deepEqual(policy(path + query), {
      outcome: "deny",
      status: 400,
      code: "plugin_query_invalid",
    });
  for (const invalid of [
    path + "/",
    path + "/extra",
    path.replace("/parts/0/", "/parts/00/"),
    path.replace("/parts/0/", "/parts/306/"),
    path.replace("/parts/0/", "/parts/-1/"),
    path.replace("/parts/0/", "/parts/%30/"),
    path.replace("original-upload", "%6Friginal-upload"),
    path.replace(mount, "short"),
    path.replace("/parts/0/", "/parts/0/sha256:"),
    path.replace("a".repeat(64), "A".repeat(64)),
    path.replace("/original-upload/", "/../"),
    path.replace("/original-upload/", "/%2e%2e/"),
    path.replace("source-uploads", "source%2Duploads"),
    path.replace("/api/v1/plugins/", "/api/v1/%70lugins/"),
  ])
    assert.deepEqual(
      policy(invalid),
      {
        outcome: "deny",
        status: 404,
        code: "route_not_found",
      },
      invalid,
    );
});

test("independent raw reader preserves native bytes up to 64 KiB without broadening the JSON reader", async () => {
  for (const size of [1, PROJECT_SOURCE_UPLOAD_PART_BYTES]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    assert.deepEqual(
      await boundedPluginSourceUploadPartRequest(
        request(bytes, { "content-length": String(size) }),
        new AbortController().signal,
      ),
      bytes,
    );
    await assert.rejects(
      boundedPluginProxyRequest(request(bytes), new AbortController().signal),
      /plugin_request_invalid/u,
    );
  }
});

test("raw reader refuses non-octet types, any content encoding, empty and mismatched lengths", async () => {
  const invalidHeaders: readonly Record<string, string>[] = [
    { "content-type": "application/json" },
    { "content-type": "application/octet-stream; charset=utf-8" },
    { "content-type": "text/plain" },
    { "content-encoding": "gzip" },
    { "content-encoding": "identity" },
    { "content-encoding": "" },
    { "content-length": "2" },
  ];
  for (const headers of invalidHeaders)
    await assert.rejects(
      boundedPluginSourceUploadPartRequest(
        request(new Uint8Array(1), headers),
        new AbortController().signal,
      ),
      /plugin_request_invalid/u,
    );
  for (const body of [null, new Uint8Array()])
    await assert.rejects(
      boundedPluginSourceUploadPartRequest(
        request(body),
        new AbortController().signal,
      ),
      /plugin_(?:request_invalid|body_missing)/u,
    );
  await assert.rejects(
    boundedPluginSourceUploadPartRequest(
      request(new Uint8Array(1), {}, "POST"),
      new AbortController().signal,
    ),
    /plugin_request_invalid/u,
  );
});

test("raw reader cancels declared or streamed overflow and caller abort without retaining a live read", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!declared)
          controller.enqueue(
            new Uint8Array(PROJECT_SOURCE_UPLOAD_PART_BYTES + 1),
          );
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      boundedPluginSourceUploadPartRequest(
        request(body, declared ? { "content-length": "65537" } : {}),
        new AbortController().signal,
      ),
      /plugin_body_too_large/u,
    );
    assert.equal(cancelled, true);
  }
  let cancelled = false;
  const controller = new AbortController();
  const pending = boundedPluginSourceUploadPartRequest(
    request(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
    controller.signal,
  );
  controller.abort(new Error("caller_cancelled"));
  await assert.rejects(pending);
  assert.equal(cancelled, true);
});

test("raw part success and error replies both retain the independent 60 KiB JSON budget", async () => {
  const allowed = policy()!;
  if (allowed.outcome !== "allow") throw new Error("fixture_policy_invalid");
  for (const status of [200, 409]) {
    const accepted = await boundedPluginProxyResponse({
      upstream: Response.json({ result: "bounded" }, { status }),
      policy: allowed,
      signal: new AbortController().signal,
    });
    assert.equal(accepted.status, status);
    for (const declared of [true, false]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!declared)
            controller.enqueue(
              new Uint8Array(MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES + 1),
            );
        },
        cancel() {
          cancelled = true;
        },
      });
      await assert.rejects(
        boundedPluginProxyResponse({
          upstream: new Response(body, {
            status,
            headers: {
              "content-type": "application/json",
              ...(declared
                ? {
                    "content-length": String(
                      MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES + 1,
                    ),
                  }
                : {}),
            },
          }),
          policy: allowed,
          signal: new AbortController().signal,
        }),
        /plugin_body_too_large/u,
      );
      assert.equal(cancelled, true);
    }
  }
});
