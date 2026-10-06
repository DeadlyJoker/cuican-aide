import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type {
  ProjectReferenceMaterialReadAuthorizationPort,
  ProjectReferenceMaterialSourceAdapter,
} from "@crewon/application";
import { projectAssetReferenceImageFixture } from "../../../packages/store/src/project-asset-reference-image.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { ProjectReferenceMaterialReader } from "./project-reference-material-reader.ts";
import type {
  PinnedHttpRequest,
  PinnedHttpResponse,
} from "./pinned-node-http.ts";
import { materialPng } from "./project-material-png.test-support.ts";

/** Real project/source/Run proofs; named provider decoder, media policy, DNS and HTTP ports.
 * Separate transport tests exercise actual sockets. This fixture does not prove external Comfy project execution.
 */
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} material read ties actual PNG bytes to the adopted original reference with no writes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetReferenceImageFixture(t, backend),
        requests: PinnedHttpRequest[] = [],
        grants: Parameters<
          ProjectReferenceMaterialReadAuthorizationPort["authorize"]
        >[0][] = [];
      const bytes = materialPng(),
        before = await f.rows();
      const reader = new ProjectReferenceMaterialReader({
        sources: f.resolver(),
        adapter: namedAdapter,
        authorization: {
          authorize: async (q) => {
            grants.push(q);
            return { outcome: "allow" };
          },
        },
        clock: { now: () => "2026-10-06T08:00:00.000Z" },
        dns: publicDns,
        transport: {
          request: async (q) => {
            requests.push(q);
            return response(bytes);
          },
        },
      });
      const result = await reader.readSelectedReference(f.actor, f.query, {
        signal: new AbortController().signal,
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.method, "GET");
      assert.equal(requests[0]!.body, undefined);
      assert.equal(requests[0]!.target.address, "8.8.8.8");
      assert.equal(
        requests[0]!.target.endpoint.href,
        "https://provider.example/original/0.png",
      );
      assert.equal(requests[0]!.maxRequestBytes, 0);
      assert.equal(requests[0]!.maxResponseBytes, 16 * 1024 * 1024);
      assert.equal(
        result.byteDigest,
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
      assert.equal(result.width, 2);
      assert.equal(result.height, 1);
      assert.equal(result.output.filename, "original-0.png");
      assert.equal(result.referenceRevision, 1);
      assert.equal(
        result.configurationDigest,
        f.link.binding.configurationDigest,
      );
      assert.equal(grants.length, 3);
      assert.ok(
        grants.every(
          (g) =>
            g.resource.referenceDigest === result.referenceDigest &&
            g.resource.origin === result.origin,
        ),
      );
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} project access does not authorize media I/O and private DNS is denied`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetReferenceImageFixture(t, backend);
      let requests = 0,
        dns = 0;
      const deps = {
        sources: f.resolver(),
        adapter: namedAdapter,
        clock: { now: () => "2026-10-06T08:00:00.000Z" },
        transport: {
          request: async () => {
            requests++;
            return response(materialPng());
          },
        },
      };
      const denied = new ProjectReferenceMaterialReader({
        ...deps,
        authorization: {
          authorize: async () => ({
            outcome: "deny",
            reasonCode: "named_no_material_grant",
          }),
        },
        dns: {
          resolveAll: async () => {
            dns++;
            return [{ address: "8.8.8.8", family: 4 }];
          },
        },
      });
      await assert.rejects(
        denied.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
        /read_denied/u,
      );
      assert.equal(requests, 0);
      assert.equal(dns, 0);
      const privateDns = new ProjectReferenceMaterialReader({
        ...deps,
        authorization: allow,
        dns: { resolveAll: async () => [{ address: "127.0.0.1", family: 4 }] },
      });
      await assert.rejects(
        privateDns.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
        /network_egress_denied/u,
      );
      assert.equal(requests, 0);
    },
  );

  test(
    `${backend} source selection and media grant are rechecked after DNS before GET`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetReferenceImageFixture(t, backend);
      let allowed = true,
        requests = 0;
      const deps = {
        sources: f.resolver(),
        adapter: namedAdapter,
        clock: { now: () => "2026-10-06T08:00:00.000Z" },
        transport: {
          request: async () => {
            requests++;
            return response(materialPng());
          },
        },
      };
      const revoked = new ProjectReferenceMaterialReader({
        ...deps,
        authorization: {
          authorize: async () =>
            allowed
              ? { outcome: "allow" }
              : { outcome: "deny", reasonCode: "named_revoked_media_grant" },
        },
        dns: {
          resolveAll: async () => {
            allowed = false;
            return [{ address: "8.8.8.8", family: 4 }];
          },
        },
      });
      await assert.rejects(
        revoked.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
        /read_denied/u,
      );
      assert.equal(requests, 0);
      const changed = new ProjectReferenceMaterialReader({
        ...deps,
        authorization: allow,
        dns: {
          resolveAll: async () => {
            await f.assets.setLocked(f.actor, {
              projectId: f.query.projectId,
              assetId: f.query.assetId,
              expectedAssetRevision: 4,
              locked: true,
              idempotencyKey: "change-during-dns",
            });
            return [{ address: "8.8.8.8", family: 4 }];
          },
        },
      });
      await assert.rejects(
        changed.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
        /reference_image_changed/u,
      );
      assert.equal(requests, 0);
    },
  );

  test(
    `${backend} stale source or revoked project/media access after HTTP cannot produce a current byte observation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetReferenceImageFixture(t, backend);
      let requests = 0;
      const reader = new ProjectReferenceMaterialReader({
        sources: f.resolver(),
        adapter: namedAdapter,
        authorization: allow,
        clock: { now: () => "2026-10-06T08:00:00.000Z" },
        dns: publicDns,
        transport: {
          request: async () => {
            requests++;
            f.policy.allow = false;
            return response(materialPng());
          },
        },
      });
      await assert.rejects(
        reader.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
      );
      assert.equal(requests, 1);
      f.policy.allow = true;
      let mediaAllowed = true;
      const mediaRevoked = new ProjectReferenceMaterialReader({
        sources: f.resolver(),
        adapter: namedAdapter,
        authorization: {
          authorize: async () =>
            mediaAllowed
              ? { outcome: "allow" }
              : {
                  outcome: "deny",
                  reasonCode: "named_media_revoked_after_http",
                },
        },
        clock: { now: () => "2026-10-06T08:00:00.000Z" },
        dns: publicDns,
        transport: {
          request: async () => {
            mediaAllowed = false;
            return response(materialPng());
          },
        },
      });
      await assert.rejects(
        mediaRevoked.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
        /read_denied/u,
      );
      const changed = new ProjectReferenceMaterialReader({
        sources: f.resolver(),
        adapter: namedAdapter,
        authorization: allow,
        clock: { now: () => "2026-10-06T08:00:00.000Z" },
        dns: publicDns,
        transport: {
          request: async () => {
            await f.assets.setLocked(f.actor, {
              projectId: f.query.projectId,
              assetId: f.query.assetId,
              expectedAssetRevision: 4,
              locked: true,
              idempotencyKey: "change-during-http",
            });
            return response(materialPng());
          },
        },
      });
      await assert.rejects(
        changed.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
        /reference_image_changed/u,
      );
    },
  );

  test(
    `${backend} redirects, encoded bodies, misleading MIME and malformed PNG never become references`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetReferenceImageFixture(t, backend),
        before = await f.rows();
      for (const result of [
        {
          ...response(materialPng()),
          status: 302,
          headers: {
            "location": "https://other.example/",
            "content-type": "image/png",
          },
        },
        {
          ...response(materialPng()),
          headers: { "content-type": "text/html" },
        },
        {
          ...response(materialPng()),
          headers: { "content-type": "image/png", "content-length": "1" },
        },
        {
          ...response(materialPng()),
          headers: { "content-type": "image/png", "content-encoding": "gzip" },
        },
        response(Buffer.from("invalid png")),
        response(Buffer.alloc(16 * 1024 * 1024 + 1)),
      ]) {
        let requests = 0;
        const reader = new ProjectReferenceMaterialReader({
          sources: f.resolver(),
          adapter: namedAdapter,
          authorization: allow,
          clock: { now: () => "2026-10-06T08:00:00.000Z" },
          dns: publicDns,
          transport: {
            request: async () => {
              requests++;
              return result;
            },
          },
        });
        await assert.rejects(
          reader.readSelectedReference(f.actor, f.query, {
            signal: new AbortController().signal,
          }),
        );
        assert.equal(requests, 1);
      }
      assert.deepEqual(await f.rows(), before);
    },
  );

  test(
    `${backend} arbitrary URL input, captured destination substitution and aborted reads send no request`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetReferenceImageFixture(t, backend);
      let requests = 0;
      const deps = {
        sources: f.resolver(),
        authorization: allow,
        clock: { now: () => "2026-10-06T08:00:00.000Z" },
        dns: publicDns,
        transport: {
          request: async () => {
            requests++;
            return response(materialPng());
          },
        },
      };
      const reader = new ProjectReferenceMaterialReader({
        ...deps,
        adapter: namedAdapter,
      });
      await assert.rejects(
        reader.readSelectedReference(
          f.actor,
          { ...f.query, url: "https://other.example/" } as never,
          { signal: new AbortController().signal },
        ),
      );
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        reader.readSelectedReference(f.actor, f.query, {
          signal: controller.signal,
        }),
      );
      const substituted = new ProjectReferenceMaterialReader({
        ...deps,
        adapter: {
          deriveReadDestination: (s) => ({
            ...namedAdapter.deriveReadDestination(s),
            origin: "https://other.example/",
          }),
        },
      });
      await assert.rejects(
        substituted.readSelectedReference(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
        /destination_invalid/u,
      );
      assert.equal(requests, 0);
    },
  );
}

const namedAdapter: ProjectReferenceMaterialSourceAdapter = {
  deriveReadDestination(source) {
    const url = new URL(source.resultLink.image.url);
    return {
      origin: url.origin + "/",
      path: url.pathname + url.search,
      output: {
        filename: source.resultLink.image.filename,
        subfolder: "named-fixture",
        type: "output",
      },
    };
  },
};
const publicDns = {
  resolveAll: async () => [{ address: "8.8.8.8", family: 4 as const }],
};
const allow: ProjectReferenceMaterialReadAuthorizationPort = {
  authorize: async () => ({ outcome: "allow" }),
};
function response(body: Uint8Array): PinnedHttpResponse {
  return { status: 200, headers: { "content-type": "image/png" }, body };
}
