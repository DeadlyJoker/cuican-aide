import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { CreativeProjectControlClient } from "./creative-project-control-client.ts";
import type { SelectConceptImageRequest } from "@crewon/contracts";

const locator = { projectId: "项目 /%2F", assetId: "概念\\ %" };
const request = (): SelectConceptImageRequest => ({
  reference: {
    ...locator,
    assetRevision: 2,
    expectedProjectRevision: 7,
    expectedAssetMetadataRevision: 3,
  },
  operationId: "00000000-0000-4000-8000-000000000123",
  expectedOperationRevision: 4,
  resultIndex: 2,
  expectedSelectionRevision: 0,
});
const image = () => ({
  reference: { ...locator, assetRevision: 2 },
  operationId: request().operationId,
  operationRevision: 4,
  resultIndex: 2,
  filename: "chosen.png",
  url: "https://provider.test/view?filename=chosen.png",
  selectedAt: "2026-10-04T00:00:00.000Z",
});
const receipt = () => ({
  disposition: "committed",
  selectionRevision: 1,
  selection: image(),
});
const expectedPath = `https://control.test/api/v1/creative-projects/${encodeURIComponent(locator.projectId)}/concepts/${encodeURIComponent(locator.assetId)}/selection`;
const client = (
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "original-csrf",
) =>
  new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "fixture-session",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  }).creativeProjects;

test("selection read uses finite authenticated GET without mutating or inventing empty state", async () => {
  const current = {
    selectionRevision: 5,
    current: { ...image(), resultIndex: 0, requiresConfirmation: true },
  };
  const api = client(async (url, init) => {
    assert.equal(String(url), expectedPath);
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "manual");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-session",
    );
    assert.equal(new Headers(init?.headers).get("idempotency-key"), null);
    return Response.json(current);
  });
  assert.deepEqual(await api.getConceptSelection(locator), current);
});

test("write freezes exact raw image and both metadata/selection CAS, using original CSRF and key", async () => {
  const source = structuredClone(request());
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = client(async (url, init) => {
    assert.equal(String(url), expectedPath);
    assert.equal(init?.method, "PUT");
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(JSON.parse(init?.body as string), request());
    assert.equal(
      new Headers(init?.headers).get("idempotency-key"),
      "choose-one",
    );
    assert.equal(
      new Headers(init?.headers).get("x-csrf-token"),
      "original-csrf",
    );
    await held;
    return Response.json(receipt());
  });
  const pending = api.selectConceptImage(source, "choose-one");
  Object.assign(source.reference, { assetRevision: 99 });
  Object.assign(source, { resultIndex: 0, expectedSelectionRevision: 99 });
  release();
  assert.deepEqual(await pending, receipt());
});

test("caller URL, source mode, ownership and invalid keys never reach HTTP", async () => {
  let calls = 0;
  const api = client(async () => {
    calls++;
    return Response.json(receipt());
  });
  for (const field of [
    "url",
    "source",
    "owner",
    "price",
    "configurationRevision",
    "providerReferenceJson",
  ])
    await assert.rejects(
      api.selectConceptImage(
        { ...request(), [field]: "forged" } as SelectConceptImageRequest,
        "key",
      ),
      ControlApiProtocolError,
    );
  await assert.rejects(
    api.selectConceptImage(request(), "multiple,keys"),
    ControlApiProtocolError,
  );
  const forgedRead = { ...locator, assetRevision: 2 };
  await assert.rejects(
    api.getConceptSelection(forgedRead),
    ControlApiProtocolError,
  );
  assert.equal(calls, 0);
});

test("write requires existing CSRF; missing capability and CAS conflict remain errors", async () => {
  let calls = 0;
  await assert.rejects(
    client(async () => {
      calls++;
      return Response.json(receipt());
    }, null).selectConceptImage(request(), "key"),
  );
  assert.equal(calls, 0);
  for (const status of [403, 404, 409])
    await assert.rejects(
      client(async () =>
        Response.json(
          {
            error: {
              category:
                status === 403
                  ? "authorization"
                  : status === 404
                    ? "notFound"
                    : "conflict",
              code: "selection_unavailable",
              requestId: "fixture-request",
            },
          },
          { status },
        ),
      ).getConceptSelection(locator),
      (error) =>
        error instanceof ControlApiClientError && error.status === status,
    );
});

test("rejects wrong receipt choice and streams over the 24 KiB response limit", async () => {
  await assert.rejects(
    client(async () =>
      Response.json({
        ...receipt(),
        selection: { ...image(), resultIndex: 0 },
      }),
    ).selectConceptImage(request(), "key"),
    ControlApiProtocolError,
  );
  await assert.rejects(
    client(
      async () =>
        new Response(
          JSON.stringify({ ...receipt(), padding: "a".repeat(24 * 1024) }),
          { headers: { "content-type": "application/json" } },
        ),
    ).selectConceptImage(request(), "key"),
    ControlApiProtocolError,
  );
});

test("logical close and deadline suppress late physical writes without retry", async () => {
  let resolve!: (value: unknown) => void,
    calls = 0;
  const late = new Promise<unknown>((done) => {
    resolve = done;
  });
  const api = new CreativeProjectControlClient(
    {
      json: async () => {
        calls++;
        return late;
      },
      protocolError: (code) => new ControlApiProtocolError(code),
    },
    { deadlineMs: 10 },
  );
  await assert.rejects(
    api.selectConceptImage(request(), "one-key"),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
  resolve(receipt());
  await Promise.resolve();
  assert.equal(calls, 1);
  const controller = new AbortController(),
    reason = new Error("caller-ended");
  controller.abort(reason);
  await assert.rejects(
    api.selectConceptImage(request(), "one-key", { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 1);
});
