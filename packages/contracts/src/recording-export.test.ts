import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJsonValue } from "./canonical-json.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  createSyntheticRecordingExport,
  SYNTHETIC_RECORDING_EVIDENCE_SVG,
} from "./recording-export.fixture.ts";
import {
  RECORDING_BUDGETS,
  sealRecordingExport,
  validateRecordingExport,
  type RecordingExport,
  type RecordingExportBody,
} from "./recording-export.ts";

async function fixtureBody(): Promise<RecordingExportBody> {
  const { contentDigest, ...body } = await createSyntheticRecordingExport();
  void contentDigest;
  return body;
}

const contractError = (error: unknown) =>
  error instanceof ContractValidationError;

async function rejectsMutation(
  mutate: (body: RecordingExportBody) => void,
): Promise<void> {
  const body = await fixtureBody();
  mutate(body);
  await assert.rejects(() => sealRecordingExport(body), contractError);
}

test("F02-R06 synthetic C01 roundtrip has independently reproducible digest and explicit provenance", async () => {
  const fixture = await createSyntheticRecordingExport();
  assert.deepEqual(await validateRecordingExport(fixture), fixture);
  const { contentDigest, ...body } = fixture;
  assert.equal(
    contentDigest,
    `sha256:${createHash("sha256").update(canonicalJsonValue(body)).digest("hex")}`,
  );
  assert.equal(
    fixture.evidence[0].contentDigest,
    `sha256:${createHash("sha256").update(SYNTHETIC_RECORDING_EVIDENCE_SVG).digest("hex")}`,
  );
  assert.equal(fixture.scope.ownerId, "synthetic-owner");
  assert.equal(fixture.steps[1].input?.classification, "parameter-candidate");
  assert.deepEqual(
    fixture.steps.map((step) => step.sequence),
    [1, 3, 4, 5, 6, 7],
  );
  assert.equal(fixture.steps[4].outcome, "unknown");
  const reordered = Object.fromEntries(Object.entries(fixture).reverse());
  assert.deepEqual(await validateRecordingExport(reordered), fixture);
});

test("F02-R06 detects content tampering, requires digest, rejects unknown version and nested fields", async () => {
  const fixture = await createSyntheticRecordingExport();
  fixture.steps[1].input = { classification: "ordinary", value: "South" };
  await assert.rejects(() => validateRecordingExport(fixture), {
    code: "recording_export_digest_mismatch",
  });
  const body = await fixtureBody();
  await assert.rejects(() => validateRecordingExport(body), contractError);
  for (const mutate of [
    (value: RecordingExportBody) => {
      (value as unknown as { schemaVersion: number }).schemaVersion = 2;
    },
    (value: RecordingExportBody) => {
      Object.assign(value, { cookie: "secret" });
    },
    (value: RecordingExportBody) => {
      Object.assign(value.scope, { role: "admin" });
    },
    (value: RecordingExportBody) => {
      Object.assign(value.steps[1].target!, { innerHTML: "secret" });
    },
    (value: RecordingExportBody) => {
      Object.assign(value.steps[1].input!, { password: "secret" });
    },
    (value: RecordingExportBody) => {
      value.steps[1].input = Object.assign(
        { classification: "runtime-required" as const },
        { value: "secret" },
      );
    },
    (value: RecordingExportBody) => {
      Object.assign(value.evidence[0], { path: "/etc/passwd" });
    },
    (value: RecordingExportBody) => {
      Object.assign(value.edits[0], { oldValue: "secret" });
    },
  ])
    await rejectsMutation(mutate);
});

test("F02-R03 C01 accepts runtime-required marker with no value, origin-only authorized pages", async () => {
  const body = await fixtureBody();
  body.steps[1].input = { classification: "runtime-required" };
  assert.equal(
    (await sealRecordingExport(body)).steps[1].input?.classification,
    "runtime-required",
  );
  for (const badOrigin of [
    "file:///tmp/example",
    "https://user:pass@teaching.example",
    "https://teaching.example/",
    "https://teaching.example/path",
    "https://teaching.example?token=secret",
    "https://other.example",
    "null",
  ]) {
    await rejectsMutation((value) => {
      value.steps[0].page.origin = badOrigin;
    });
  }
  await rejectsMutation((value) => {
    value.authorization.allowedOrigins.push(
      value.authorization.allowedOrigins[0],
    );
  });
  await rejectsMutation((value) => {
    value.authorization.allowedOrigins = [];
  });
  await rejectsMutation((value) => {
    value.steps[0].page.routeDigest =
      "https://example.test/secret" as `sha256:${string}`;
  });
});

test("F02-R04 C01 preserves stable order and rejects dangling or inconsistent edits and evidence", async () => {
  for (const mutate of [
    (value: RecordingExportBody) => {
      value.steps[1].stepId = value.steps[0].stepId;
    },
    (value: RecordingExportBody) => {
      value.steps[1].sequence = value.steps[0].sequence;
    },
    (value: RecordingExportBody) => {
      value.steps.reverse();
    },
    (value: RecordingExportBody) => {
      value.steps[0].evidenceIds = ["missing"];
    },
    (value: RecordingExportBody) => {
      value.steps[0].evidenceIds.push(value.steps[0].evidenceIds[0]);
    },
    (value: RecordingExportBody) => {
      value.evidence.push(value.evidence[0]);
    },
    (value: RecordingExportBody) => {
      value.steps[4].relatedStepId = "synthetic-step-2";
    },
    (value: RecordingExportBody) => {
      value.steps[4].relatedStepId = value.steps[4].stepId;
    },
    (value: RecordingExportBody) => {
      value.edits[1].stepId = value.steps[0].stepId;
    },
    (value: RecordingExportBody) => {
      value.edits[0].stepId = "missing";
    },
    (value: RecordingExportBody) => {
      value.edits[0].revision = value.revision + 1;
    },
    (value: RecordingExportBody) => {
      value.edits.reverse();
    },
  ])
    await rejectsMutation(mutate);
  const body = await fixtureBody();
  const deletedId = body.steps[3].stepId;
  body.steps.splice(3, 1);
  body.steps[3].relatedStepId = null;
  body.edits.push({
    operation: "delete",
    revision: 11,
    stepId: deletedId,
    at: body.updatedAt,
  });
  await sealRecordingExport(body);
});

test("F02-R05 C01 rejects malformed time and status/revision, but permits recovery after duration", async () => {
  for (const mutate of [
    (value: RecordingExportBody) => {
      value.updatedAt = "2026-02-31T00:00:00.000Z";
    },
    (value: RecordingExportBody) => {
      value.updatedAt = value.startedAt;
    },
    (value: RecordingExportBody) => {
      value.startedAt = "yesterday";
    },
    (value: RecordingExportBody) => {
      value.authorization.authorizedAt = value.updatedAt;
    },
    (value: RecordingExportBody) => {
      value.steps[0].occurredAt = "2026-09-15T00:00:00.000Z";
    },
    (value: RecordingExportBody) => {
      value.revision = 0;
    },
    (value: RecordingExportBody) => {
      value.revision = 1;
    },
    (value: RecordingExportBody) => {
      value.status = "done" as RecordingExport["status"];
    },
  ])
    await rejectsMutation(mutate);
  const body = await fixtureBody();
  body.updatedAt = "2026-09-15T00:00:00.000Z";
  body.status = "interrupted";
  await sealRecordingExport(body);
});

test("F02-R07 C01 enforces steps, individual evidence, edit and total UTF-8 byte budgets", async () => {
  await rejectsMutation((value) => {
    value.steps = Array.from({ length: 201 }, () => value.steps[0]);
  });
  await rejectsMutation((value) => {
    value.edits = Array.from({ length: 401 }, () => value.edits[0]);
  });
  await rejectsMutation((value) => {
    value.evidence[0].byteLength = RECORDING_BUDGETS.maxEvidenceBytes + 1;
  });
  await rejectsMutation((value) => {
    value.evidence[0].byteLength = 0;
  });
  await rejectsMutation((value) => {
    value.evidence[0].contentDigest = "sha256:invalid";
  });
  await rejectsMutation((value) => {
    value.steps[1].input = {
      classification: "ordinary",
      value: "🙂".repeat(600),
    };
  });
  const body = await fixtureBody();
  body.evidence = Array.from({ length: 128 }, (_, index) => ({
    ...body.evidence[0],
    evidenceId: index === 0 ? "synthetic-evidence-1" : `extra-${index}`,
    byteLength: RECORDING_BUDGETS.maxEvidenceBytes,
  }));
  await assert.rejects(() => sealRecordingExport(body), {
    code: "recording_export_total_budget_exceeded",
  });
});

test("C01 returns a detached snapshot and rejects non-JSON fields without invoking accessors", async () => {
  const fixture = await createSyntheticRecordingExport();
  const validated = await validateRecordingExport(fixture);
  fixture.steps[0].note = "changed after validation";
  assert.equal(validated.steps[0].note, null);
  const body = await fixtureBody();
  let invoked = false;
  Object.defineProperty(body.scope, "ownerId", {
    enumerable: true,
    get() {
      invoked = true;
      return "owner";
    },
  });
  await assert.rejects(() => sealRecordingExport(body), contractError);
  assert.equal(invoked, false);
  await rejectsMutation((value) => {
    value.steps[0].note = "\ud800";
  });
});

test("F02-R03 route templates retain semantic path and runtime query slots without credentials or values", async () => {
  const body = await fixtureBody();
  assert.equal(
    body.steps[0].page.routeTemplate,
    "https://teaching.example/orders?date={runtime}",
  );
  assert.equal(body.steps[1].target?.accessibleName, "Region");
  for (const template of [
    "https://teaching.example/orders?date=secret",
    "https://teaching.example/orders#secret",
    "https://user:password@teaching.example/orders",
    "https://elsewhere.example/orders",
    "https://teaching.example/orders?access%20token={runtime}",
  ])
    await rejectsMutation((value) => {
      value.steps[0].page.routeTemplate = template;
    });
  await rejectsMutation((value) => {
    value.steps[0].page.routeTemplate = "a".repeat(2_049);
  });
});

test("F02-R06 permits redacted screenshots only with PNG metadata", async () => {
  const body = await fixtureBody();
  body.evidence[0].kind = "redacted-screenshot";
  body.evidence[0].mediaType = "image/png";
  await sealRecordingExport(body);
  body.evidence[0].mediaType = "image/svg+xml";
  await assert.rejects(() => sealRecordingExport(body), contractError);
});
