import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { SqliteDeliveryStore } from "@crewon/store";
import { ControlApiClient } from "@crewon/control-client";
import {
  XLSX_MEDIA_TYPE,
  type DeliveryInputRecord,
  type DeliveryVersionRecord,
} from "@crewon/domain";
import { createStandaloneControlApi } from "./standalone-composition.ts";

const readXlsx = createRequire(
  new URL("../../crewon-ui/package.json", import.meta.url),
)("xlsx").read;
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../docs/sdd/F01-delivery/fixtures/${name}`, import.meta.url),
  );
const headers = {
  "authorization": "Bearer delivery-session-32-bytes-minimum",
  "origin": "http://127.0.0.1:5175",
  "x-csrf-token": "delivery-csrf-32-bytes-minimum-val",
};

test("F01 E01/E02 real HTTP uploads, full rules, XLSX checks, manual edits, CAS, authenticated reopen and byte downloads", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "crewon-f01-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () =>
    createStandaloneControlApi({
      databasePath: path.join(dir, "control.sqlite"),
      deliveryStore: new SqliteDeliveryStore({
        databasePath: path.join(dir, "delivery.sqlite"),
        encryptionKey: new Uint8Array(32).fill(8),
      }),
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "artifact-key",
      actor: {
        tenantId: "tenant",
        spaceId: "space",
        actorId: "actor",
        principalId: "principal",
      },
      defaultAgentVersionId: "agent",
      sessionToken: "delivery-session-32-bytes-minimum",
      csrfToken: headers["x-csrf-token"],
      allowedOrigins: [headers.origin],
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      automationScanIntervalMs: null,
    });
  let runtime = open();
  t.after(() => runtime.app.close());
  const create = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: { ...headers, "idempotency-key": "thread" },
    payload: { title: "订单验收" },
  });
  assert.equal(create.statusCode, 201, create.body);
  const threadId = create.json().thread.threadId;
  const base = `/api/v1/threads/${threadId}/delivery`;
  const post = (suffix: string, payload: object, key: string) =>
    runtime.app.inject({
      method: "POST",
      url: `${base}/${suffix}`,
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
  const upload = async (name: string, role: "data" | "template") => {
    const bytes = fixture(name);
    const response = await post(
      "inputs",
      {
        name,
        role,
        mediaType: name.endsWith(".csv") ? "text/csv" : XLSX_MEDIA_TYPE,
        contentBase64: bytes.toString("base64"),
      },
      name,
    );
    assert.equal(response.statusCode, 200, response.body);
    const input = response.json<DeliveryInputRecord>();
    assert.equal(input.sourceRunId, null);
    const downloaded = await runtime.app.inject({
      method: "GET",
      url: `${base}/inputs/${input.inputId}/content`,
      headers,
    });
    assert.deepEqual(downloaded.rawPayload, bytes);
    return input;
  };
  const a = await upload("orders-a.csv", "data");
  const b = await upload("orders-b.csv", "data");
  const template = await upload("orders-template.xlsx", "template");
  const request = {
    name: "订单.xlsx",
    templateInputId: template.inputId,
    sources: [a, b].map((input) => ({
      inputId: input.inputId,
      sheet: "CSV",
      headerRow: 1,
    })),
    targetSheet: "明细",
    startRow: 2,
    columns: ["order_id", "channel", "currency", "amount", "status"].map(
      (sourceHeader, index) => ({
        sourceHeader,
        targetColumn: String.fromCharCode(65 + index),
      }),
    ),
    rules: {
      exclude: [{ header: "status", equals: "canceled" }],
      requiredHeaders: ["amount"],
      exceptionSheet: "异常",
      lineageSheet: "来源",
      summary: {
        sheet: "汇总",
        startRow: 2,
        groupBy: ["channel", "currency"],
        valueHeader: "amount",
      },
    },
  };
  const response = await post("assemble", request, "assemble");
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<DeliveryVersionRecord>();
  assert.equal(result.validation.writtenRows, 5);
  assert.equal(
    result.validation.sources.reduce((n, s) => n + s.readRows, 0),
    7,
  );
  assert.equal(
    result.validation.sources.reduce(
      (n, s) => n + (s.excludedRuleRows ?? 0),
      0,
    ),
    1,
  );
  assert.equal(
    result.validation.sources.reduce((n, s) => n + (s.exceptionRows ?? 0), 0),
    1,
  );
  const download = async (version: DeliveryVersionRecord) => {
    const file = await runtime.app.inject({
      method: "GET",
      url: `${base}/versions/${version.versionId}/content`,
      headers,
    });
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(
      `sha256:${createHash("sha256").update(file.rawPayload).digest("hex")}`,
      version.contentDigest,
    );
    assert.equal(file.rawPayload.length, version.byteLength);
    return readXlsx(file.rawPayload, {
      type: "buffer",
      cellStyles: true,
      cellNF: true,
    });
  };
  const independent = await download(result);
  assert.deepEqual(
    [
      independent.Sheets["汇总"].C2.v,
      independent.Sheets["汇总"].C3.v,
      independent.Sheets["汇总"].C4.v,
    ],
    [180, 10, 150],
  );
  assert.equal(independent.Sheets["汇总"].D2.v, 180);
  assert.equal(independent.Sheets["异常"].E2.v, "B002");
  assert.equal(independent.Sheets["明细"].H1.v, "用户原始备注");
  const manualBody = {
    deliveryId: result.deliveryId,
    expectedVersionId: result.versionId,
    expectedContentDigest: result.contentDigest,
    patches: [{ sheet: "明细", cell: "H1", value: "已核对渠道口径" }],
  };
  const manualResponse = await post("patch", manualBody, "manual");
  assert.equal(manualResponse.statusCode, 200, manualResponse.body);
  const manual = manualResponse.json<DeliveryVersionRecord>();
  assert.equal(
    (
      await post(
        "patch",
        { ...manualBody, patches: [{ sheet: "明细", cell: "D2", value: 100 }] },
        "stale",
      )
    ).statusCode,
    409,
  );
  const precisionBody = {
    deliveryId: manual.deliveryId,
    expectedVersionId: manual.versionId,
    expectedContentDigest: manual.contentDigest,
    patches: [{ sheet: "明细", cell: "D2", value: 100, numberFormat: "0.0" }],
  };
  const precisionResponse = await post("patch", precisionBody, "precision");
  assert.equal(precisionResponse.statusCode, 200, precisionResponse.body);
  const precision = precisionResponse.json<DeliveryVersionRecord>();
  const edited = await download(precision);
  assert.equal(edited.Sheets["明细"].H1.v, "已核对渠道口径");
  assert.equal(edited.Sheets["明细"].D2.z, "0.0");
  assert.equal((await download(result)).Sheets["明细"].H1.v, "用户原始备注");
  assert.equal(
    (await post("assemble", request, "assemble")).json().versionId,
    result.versionId,
  );
  assert.equal(
    (await post("assemble", { ...request, sourceRunId: "forged" }, "forged"))
      .statusCode,
    400,
  );
  assert.equal(
    (await runtime.app.inject({ method: "GET", url: base })).statusCode,
    401,
  );
  assert.equal(
    (
      await runtime.app.inject({
        method: "POST",
        url: `${base}/patch`,
        headers: {
          ...headers,
          "x-csrf-token": "wrong",
          "idempotency-key": "csrf",
        },
        payload: precisionBody,
      })
    ).statusCode,
    403,
  );
  const other = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: { ...headers, "idempotency-key": "other" },
    payload: { title: "Other" },
  });
  assert.equal(
    (
      await runtime.app.inject({
        method: "GET",
        url: `/api/v1/threads/${other.json().thread.threadId}/delivery/versions/${precision.versionId}/content`,
        headers,
      })
    ).statusCode,
    404,
  );
  await runtime.app.close();
  runtime = open();
  assert.equal(
    (await runtime.app.inject({ method: "GET", url: base, headers })).json()
      .deliveries[0].versionId,
    precision.versionId,
  );
  assert.equal(
    (await post("patch", precisionBody, "precision")).json().versionId,
    precision.versionId,
  );
  assert.equal(
    (
      await runtime.app.inject({
        method: "GET",
        url: `${base}/history/${precision.deliveryId}`,
        headers,
      })
    ).json().length,
    3,
  );
  assert.equal(
    (await download(precision)).Sheets["明细"].H1.v,
    "已核对渠道口径",
  );
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ControlApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accessToken: "delivery-session-32-bytes-minimum",
    csrfToken: headers["x-csrf-token"],
    origin: headers.origin,
  });
  const catalog = await client.delivery.catalog(threadId);
  assert.equal(catalog.deliveries[0].versionId, precision.versionId);
  assert.equal(
    (
      await client.delivery.download(
        threadId,
        { kind: "version", id: precision.versionId },
        precision,
      )
    ).length,
    precision.byteLength,
  );
});
