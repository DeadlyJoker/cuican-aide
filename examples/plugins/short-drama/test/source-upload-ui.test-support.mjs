import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  createPluginProjectSourceUploadsClient,
  projectSourceUploadsCodec,
} from "@crewon/plugin-sdk/project-source-uploads";
const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const copy = (v) => structuredClone(v);
const { outputFiles } = await build({
  entryPoints: [
    new URL("../src/workbench/ProjectSourceFileUpload.ts", import.meta.url)
      .pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
export const { ProjectSourceFileUpload } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);
/** Public acknowledged-metadata fixture plus actual SDK native-byte copying/hash. No database or parser claim. */
export function sourceUploadFixture({
  pending = false,
  rejectedCode = null,
  readyAfterPoll = null,
} = {}) {
  const calls = [],
    rawCalls = [],
    parts = new Map(),
    begins = new Map();
  let current = null,
    losePart = false,
    serial = 0,
    preparationPolls = 0;
  function finish() {
    const bytes = Buffer.concat([...parts.values()]);
    const text = bytes.toString("utf8"),
      characters = Array.from(text).length;
    current = {
      ...current,
      revision: current.revision + 1,
      phase: "ready",
      prepared: {
        digest: digest(bytes),
        characterLength: characters,
        normalizedByteLength: bytes.byteLength,
        chunkCount: Math.ceil(bytes.byteLength / 4096),
        chapterCount: 0,
      },
    };
  }
  async function invoke(action, input) {
    const request = projectSourceUploadsCodec.parseRequest({ action, input });
    calls.push(copy(request));
    const method = action.split(".").at(-1);
    let response;
    if (method === "begin") {
      if (!begins.has(input.idempotencyKey)) {
        parts.clear();
        current = {
          uploadId: `native-upload-${++serial}`,
          revision: 1,
          phase: "receiving",
          fileName: input.fileName,
          format: input.format,
          byteLength: input.byteLength,
          fileDigest: input.fileDigest,
          partBytes: 65536,
          partCount: Math.ceil(input.byteLength / 65536),
          receivedParts: [],
          prepared: null,
          failureCode: null,
          updatedAt: "2026-10-08T00:00:00.000Z",
        };
        begins.set(input.idempotencyKey, copy(input));
        response = { disposition: "committed", upload: current };
      } else {
        assert.deepEqual(begins.get(input.idempotencyKey), input);
        response = { disposition: "replayed", upload: current };
      }
    } else if (method === "status") {
      if (
        current.phase === "preparing" &&
        readyAfterPoll !== null &&
        ++preparationPolls >= readyAfterPoll
      )
        finish();
      response = { upload: current };
    } else if (method === "prepare") {
      if (current.phase === "receiving")
        current = {
          ...current,
          revision: current.revision + 2,
          phase: "preparing",
        };
      if (rejectedCode) {
        current = {
          ...current,
          revision: current.revision + 1,
          phase: "rejected",
          failureCode: rejectedCode,
        };
        response = { disposition: "rejected", upload: current };
      } else if (pending || readyAfterPoll !== null)
        response = { disposition: "pending", upload: current };
      else {
        finish();
        response = { disposition: "ready", upload: current };
      }
    } else if (method === "cancel") {
      assert.equal(input.expectedRevision, current.revision);
      current = {
        ...current,
        revision: current.revision + 1,
        phase: "cancelled",
      };
      response = { disposition: "committed", upload: current };
    } else throw new Error("unknown fixture action");
    return copy(projectSourceUploadsCodec.parseResponse(response, request));
  }
  const raw = {
    async writePart(locator, bytes) {
      assert.ok(bytes instanceof Uint8Array);
      assert.ok(bytes.byteLength <= 65536);
      assert.equal(digest(bytes), locator.rawDigest);
      assert.equal(locator.uploadId, current.uploadId);
      rawCalls.push({ locator: copy(locator), bytes: new Uint8Array(bytes) });
      assert.equal(parts.has(locator.partIndex), false);
      parts.set(locator.partIndex, Buffer.from(bytes));
      current = {
        ...current,
        revision: current.revision + 1,
        receivedParts: [
          ...current.receivedParts,
          {
            index: locator.partIndex,
            byteLength: bytes.byteLength,
            rawDigest: locator.rawDigest,
          },
        ],
      };
      if (losePart) {
        losePart = false;
        throw new Error("lost_raw_response");
      }
      return copy({ disposition: "committed", upload: current });
    },
  };
  const services = { invoke, projectSourceUploads: raw };
  const client = createPluginProjectSourceUploadsClient(services, { raw });
  return {
    services,
    client,
    calls,
    rawCalls,
    parts,
    begins,
    create() {
      return new ProjectSourceFileUpload(client, { pollIntervalMs: 0 });
    },
    loseNextPartReply() {
      losePart = true;
    },
    get upload() {
      return copy(current);
    },
  };
}
