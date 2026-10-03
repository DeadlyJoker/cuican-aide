import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import {
  parseExtensionHostRequest,
  type ExtensionHostRequest,
} from "@crewon/contracts";
import { extensionCanonicalJson, parseExtensionManifest } from "@crewon/domain";
import { nativeConfigurationManifest } from "./desktop-plugin-configuration.test-support.ts";

/** Actual authenticated legacy loopback transport; deliberately no execution readiness. */
export async function nativeLegacyWorkerFixture(
  t: TestContext,
  pluginId = "test.existing-legacy",
) {
  const manifest = parseExtensionManifest({
    ...nativeConfigurationManifest,
    pluginId,
    title: "Existing legacy fixture",
  });
  const registration = {
    manifest,
    manifestDigest: `sha256:${createHash("sha256").update(extensionCanonicalJson(manifest)).digest("hex")}`,
    implementationDigest: `sha256:${"a".repeat(64)}`,
  };
  const token = "actual-legacy-loopback-fixture-token-01";
  const requests: ExtensionHostRequest[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.url, "/private/v0/extensions");
      assert.equal(incoming.headers.authorization, `Bearer ${token}`);
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = parseExtensionHostRequest(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      requests.push(request);
      const common = {
        protocol: "crewon.extension-host-response.v0",
        operation: request.operation,
        actor: request.actor,
      };
      const response =
        request.operation === "catalog"
          ? { ...common, registrations: [registration] }
          : request.operation === "validateConfiguration"
            ? {
                ...common,
                registration: request.registration,
                configurationDigest: request.configuration.contentDigest,
              }
            : {
                ...common,
                registration: request.registration,
                configurationDigest: request.configuration.contentDigest,
                agentVersionId: request.agentVersionId,
                result: {
                  outcome: "unavailable",
                  reasonCode: "extension_runtime_unavailable",
                },
              };
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(response));
    } catch (error) {
      errors.push(error);
      outgoing.writeHead(500);
      outgoing.end("actual_legacy_fixture_failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.deepEqual(errors, []);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    manifest,
    registration,
    requests,
    peer: Object.freeze({ origin: `http://127.0.0.1:${address.port}`, token }),
  };
}
