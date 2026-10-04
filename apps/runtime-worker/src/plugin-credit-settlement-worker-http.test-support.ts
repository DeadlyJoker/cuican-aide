import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";
import type {
  PluginCreditSettlementEvidence,
  PluginCreditSettlementRecoveryScope,
} from "@crewon/application";
import { extensionOpaqueId, parsePluginProfileScope } from "@crewon/domain";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

const AUTHORIZATION_SCHEMA = "crewon.plugin-credit-settlement-authorization.v1";
const REQUEST_SCHEMA = "crewon.plugin-credit-settlement-decision-request.v1";
const DECISION_SCHEMA = "crewon.plugin-credit-settlement-decision.v1";
const CONFIG_SCHEMA = "crewon.plugin-credit-settlement-worker.v1";
const authorizationTokenRef = "CREWON_FINANCIAL_TEST_AUTHORIZATION_TOKEN";
const decisionTokenRef = "CREWON_FINANCIAL_TEST_DECISION_TOKEN";
const authorizationToken = "named-financial-https-authorization-token-000001";
const decisionToken = "named-financial-https-decision-token-000001";
const MAX_REQUESTS = 256;
const MAX_BYTES = 128 * 1024;

export type FinancialHttpFixtureRequest = Readonly<{
  index: number;
  path: "/authorize" | "/decide";
  body: Readonly<Record<string, unknown>>;
  evidence: PluginCreditSettlementEvidence | null;
  responseOutcome: "allow" | "deny" | "hold" | "settle18";
  response: Readonly<Record<string, unknown>>;
}>;
export type FinancialHttpFixtureConfigurationOptions = Readonly<{
  migrate?: boolean;
  intervalMs?: number;
  maxAuthorizationAgeMs?: number;
  timeoutMs?: number;
  maxRoundMs?: number;
  batchSize?: number;
}>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function record(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "financial_https_fixture_record_invalid",
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...names].sort(),
    "financial_https_fixture_fields_invalid",
  );
  return value as Record<string, unknown>;
}
function integer(value: number, maximum: number): number {
  assert.ok(
    Number.isSafeInteger(value) && value >= 1 && value <= maximum,
    "financial_https_fixture_bound_invalid",
  );
  return value;
}
function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Named test identity and financial decisions. Uses the original trusted test CA and the caller's original fetch/TLS transport. */
export async function createPluginCreditSettlementWorkerHttpFixture(
  input: Readonly<{
    directory: string;
    scope: PluginCreditSettlementRecoveryScope;
    authorityId?: string;
    authorityRevision?: string;
    authorityEpoch?: string;
    requestAuditLimit?: number;
    observeRequest?: (request: FinancialHttpFixtureRequest) => void;
  }>,
) {
  const scope = Object.freeze(parsePluginProfileScope(input.scope));
  const authorityId = extensionOpaqueId(
    input.authorityId ?? "named-financial-https-authority",
  );
  const authorityRevision = extensionOpaqueId(
    input.authorityRevision ?? "named-financial-https-price-rule-18",
  );
  const authorityEpoch = extensionOpaqueId(
    input.authorityEpoch ?? "named-financial-https-epoch-1",
  );
  const requestAuditLimit = integer(
    input.requestAuditLimit ?? MAX_REQUESTS,
    8192,
  );
  const caPath = join(input.directory, `financial-test-ca-${randomUUID()}.pem`);
  await writeFile(caPath, TEST_CA_CERT, { mode: 0o600, flag: "wx" });
  const requests: FinancialHttpFixtureRequest[] = [];
  const failures: string[] = [];
  const sockets = new Set<Duplex>();
  const completedResponses = new Set<number>();
  const physical = new Set<Promise<void>>();
  let authorization: "allow" | "deny" = "allow";
  let decision: "hold" | "settle18" = "hold";
  let authorizationAgeMs = 10_000;
  let closing: Promise<void> | undefined;
  let pendingHold: {
    path: "/authorize" | "/decide";
    entered: ReturnType<typeof deferred>;
    closed: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | null = null;
  const activeHolds = new Set<ReturnType<typeof deferred>>();
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      const task = (async () => {
        assert.equal(
          request.method,
          "POST",
          "financial_https_fixture_method_invalid",
        );
        assert.ok(
          request.url === "/authorize" || request.url === "/decide",
          "financial_https_fixture_route_invalid",
        );
        const path: FinancialHttpFixtureRequest["path"] = request.url;
        const expectedToken =
          path === "/authorize" ? authorizationToken : decisionToken;
        if (request.headers.authorization !== `Bearer ${expectedToken}`)
          throw new Error("financial_https_fixture_credential_invalid");
        assert.equal(
          request.headers["content-type"],
          "application/json",
          "financial_https_fixture_content_type_invalid",
        );
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += Buffer.byteLength(chunk);
          assert.ok(
            bytes <= MAX_BYTES,
            "financial_https_fixture_request_too_large",
          );
          chunks.push(Buffer.from(chunk));
        }
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
        const body = record(
          value,
          path === "/authorize"
            ? ["schemaVersion", "scope", "authorityId", "authorityRevision"]
            : [
                "schemaVersion",
                "scope",
                "authorityId",
                "authorityRevision",
                "authorityEpoch",
                "evidence",
              ],
        );
        assert.equal(
          body.schemaVersion,
          path === "/authorize" ? AUTHORIZATION_SCHEMA : REQUEST_SCHEMA,
        );
        assert.deepEqual(body.scope, scope);
        assert.equal(body.authorityId, authorityId);
        assert.equal(body.authorityRevision, authorityRevision);
        let evidence: PluginCreditSettlementEvidence | null = null;
        if (path === "/decide") {
          assert.equal(body.authorityEpoch, authorityEpoch);
          const facts = record(body.evidence, [
            "schemaVersion",
            "locator",
            "spaceId",
            "actorId",
            "pluginId",
            "bindingDigest",
            "admissionDigest",
            "taskReceiptDigest",
            "installedAdmissionDigest",
            "scope",
            "reservationId",
            "priceRevision",
            "quotedCredits",
            "run",
            "operations",
            "mutationReceipts",
            "attempts",
            "workItems",
            "readyToFinalize",
            "evidenceDigest",
          ]);
          assert.equal(
            facts.schemaVersion,
            "crewon.plugin-credit-settlement-evidence.v1",
          );
          assert.equal(facts.readyToFinalize, true);
          assert.equal(facts.spaceId, scope.spaceId);
          const locator = record(facts.locator, ["tenantId", "runId"]);
          assert.equal(locator.tenantId, scope.tenantId);
          assert.equal(facts.reservationId, locator.runId);
          assert.match(
            String(facts.installedAdmissionDigest),
            /^sha256:[0-9a-f]{64}$/u,
          );
          assert.match(String(facts.evidenceDigest), /^sha256:[0-9a-f]{64}$/u);
          assert.equal(
            facts.quotedCredits,
            "30",
            "named_financial_fixture_requires_original_quote_30",
          );
          evidence = facts as unknown as PluginCreditSettlementEvidence;
        }
        assert.ok(
          requests.length < requestAuditLimit,
          "financial_https_fixture_request_limit",
        );
        const outcome = path === "/authorize" ? authorization : decision;
        const result =
          path === "/authorize"
            ? {
                schemaVersion: AUTHORIZATION_SCHEMA,
                scope,
                authorityId,
                authorityRevision,
                outcome,
                ...(outcome === "allow"
                  ? {
                      authorityEpoch,
                      expiresAt: new Date(
                        Date.now() +
                          Math.max(1, Math.floor(authorizationAgeMs / 2)),
                      ).toISOString(),
                    }
                  : {}),
              }
            : {
                schemaVersion: DECISION_SCHEMA,
                evidenceDigest: evidence!.evidenceDigest,
                authorityId,
                authorityRevision,
                decisionId: `named-financial-${createHash("sha256")
                  .update(
                    JSON.stringify([
                      authorityId,
                      authorityRevision,
                      evidence!.locator,
                      evidence!.evidenceDigest,
                      outcome,
                    ]),
                  )
                  .digest("hex")}`,
                outcome:
                  outcome === "hold"
                    ? { kind: "hold" }
                    : { kind: "settle", actualCredits: "18" },
              };
        const captured: FinancialHttpFixtureRequest =
          freezeJson<FinancialHttpFixtureRequest>({
            index: requests.length + 1,
            path,
            body,
            evidence,
            responseOutcome: outcome,
            response: result,
          });
        requests.push(captured);
        response.once("finish", () => {
          completedResponses.add(captured.index);
        });
        input.observeRequest?.(captured);
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        const json = JSON.stringify(result);
        assert.ok(Buffer.byteLength(json) <= 16 * 1024);
        const hold = pendingHold?.path === path ? pendingHold : null;
        if (hold !== null) {
          pendingHold = null;
          activeHolds.add(hold.release);
          response.once("close", () => {
            hold.closed.resolve();
            hold.release.resolve();
          });
          response.write(json.slice(0, 1));
          hold.entered.resolve();
          await hold.release.promise;
          activeHolds.delete(hold.release);
          if (!response.destroyed) response.end(json.slice(1));
        } else response.end(json);
      })().catch(() => {
        failures.push("financial_https_fixture_request_failed");
        if (!response.destroyed) {
          response.statusCode = 400;
          response.end('{"fixture":"invalid"}');
        }
      });
      physical.add(task);
      void task.finally(() => {
        physical.delete(task);
      });
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  const environment = Object.freeze({
    NODE_EXTRA_CA_CERTS: caPath,
    [authorizationTokenRef]: authorizationToken,
    [decisionTokenRef]: decisionToken,
  });
  function configuration(
    options: FinancialHttpFixtureConfigurationOptions = {},
  ) {
    authorizationAgeMs = integer(
      options.maxAuthorizationAgeMs ?? 10_000,
      30_000,
    );
    return {
      schemaVersion: CONFIG_SCHEMA,
      scope,
      authorityId,
      authorityRevision,
      authorizationAuthority: {
        url: `${origin}/authorize`,
        serviceTokenEnvironmentVariable: authorizationTokenRef,
      },
      decisionAuthority: {
        url: `${origin}/decide`,
        serviceTokenEnvironmentVariable: decisionTokenRef,
      },
      timeoutMs: integer(options.timeoutMs ?? 5_000, 30_000),
      maxAuthorizationAgeMs: authorizationAgeMs,
      batchSize: integer(options.batchSize ?? 1, 16),
      intervalMs: integer(options.intervalMs ?? 25, 3_600_000),
      maxRoundMs: integer(options.maxRoundMs ?? 10_000, 30_000),
      migrate: options.migrate ?? false,
    };
  }
  return Object.freeze({
    scope,
    authorityId,
    authorityRevision,
    authorityEpoch,
    origin,
    environment,
    requests: requests as readonly FinancialHttpFixtureRequest[],
    failures: failures as readonly string[],
    configuration,
    responseCompleted(index: number) {
      return completedResponses.has(index);
    },
    async writeConfiguration(
      path: string,
      options: FinancialHttpFixtureConfigurationOptions = {},
    ) {
      await writeFile(path, JSON.stringify(configuration(options)), {
        mode: 0o600,
        flag: "wx",
      });
      return path;
    },
    setAuthorization(value: "allow" | "deny") {
      assert.ok(value === "allow" || value === "deny");
      authorization = value;
    },
    setDecision(value: "hold" | "settle18") {
      assert.ok(value === "hold" || value === "settle18");
      decision = value;
    },
    holdNextResponse(path: "/authorize" | "/decide") {
      assert.equal(pendingHold, null);
      assert.ok(path === "/authorize" || path === "/decide");
      const hold = {
        path,
        entered: deferred(),
        closed: deferred(),
        release: deferred(),
      };
      pendingHold = hold;
      return Object.freeze({
        entered: hold.entered.promise,
        closed: hold.closed.promise,
        release: hold.release.resolve,
      });
    },
    close() {
      if (closing !== undefined) return closing;
      closing = (async () => {
        const retiring = [...sockets];
        const physicalCloses = retiring.map((socket) =>
          socket.closed
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                socket.once("close", () => {
                  resolve();
                });
              }),
        );
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        pendingHold?.release.resolve();
        pendingHold = null;
        for (const hold of activeHolds) hold.resolve();
        for (const socket of retiring) socket.destroy();
        server.closeAllConnections();
        await Promise.all([stopped, ...physicalCloses]);
        await Promise.allSettled([...physical]);
        assert.equal(
          sockets.size,
          0,
          "financial_https_fixture_socket_still_open",
        );
        assert.equal(
          physical.size,
          0,
          "financial_https_fixture_request_still_open",
        );
        assert.deepEqual(failures, []);
      })();
      return closing;
    },
  });
}
