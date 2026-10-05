import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginProjectAssetUiClient,
  type PluginProjectAssetUiServices,
} from "./project-assets-service.ts";
import { projectAssetsUiCodec } from "./project-assets-contract.ts";
import { assetPublicFixture } from "./project-assets.test-support.ts";

test("portable client captures original callbacks and invokes only the named request with no automatic retry", async () => {
  const f = assetPublicFixture(),
    calls: unknown[] = [],
    services = {
      async invoke(...args: unknown[]) {
        calls.push(args);
        return f.response;
      },
    };
  const client = createPluginProjectAssetUiClient(
    services,
    projectAssetsUiCodec,
  );
  services.invoke = async () => {
    throw new Error("replacement");
  };
  assert.deepEqual(await client.saveCandidate(f.request.input), f.response);
  assert.deepEqual(calls, [[f.request.action, f.request.input, {}]]);
  assert.ok(Object.isFrozen(client));
});
test("client rejects caller authority fields and accessors before mounted IO", async () => {
  const f = assetPublicFixture();
  let reads = 0,
    calls = 0;
  const client = createPluginProjectAssetUiClient(
    {
      async invoke() {
        calls++;
        return f.response;
      },
    },
    projectAssetsUiCodec,
  );
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  await assert.rejects(client.saveCandidate(f.request.input, options));
  await assert.rejects(
    client.saveCandidate({
      ...f.request.input,
      principalId: "foreign",
    } as never),
  );
  const getter = Object.defineProperty({}, "invoke", {
    get() {
      reads++;
      return () => f.response;
    },
  });
  assert.throws(() =>
    createPluginProjectAssetUiClient(
      getter as PluginProjectAssetUiServices,
      projectAssetsUiCodec,
    ),
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});
test("client preserves cancellation before IO and rejects a late response even if underlying invoke ignores abort", async () => {
  const f = assetPublicFixture();
  let calls = 0;
  const cancellation = new AbortController(),
    original = new Error("caller-abort");
  const client = createPluginProjectAssetUiClient(
    {
      async invoke(_action, _input, options) {
        calls++;
        assert.equal(options.signal, cancellation.signal);
        cancellation.abort(original);
        return f.response;
      },
    },
    projectAssetsUiCodec,
  );
  await assert.rejects(
    client.saveCandidate(f.request.input, { signal: cancellation.signal }),
    (error) => error === original,
  );
  await assert.rejects(
    client.saveCandidate(f.request.input, { signal: cancellation.signal }),
    (error) => error === original,
  );
  assert.equal(calls, 1);
});
test("transport errors are returned unchanged and malformed or foreign results cannot become confirmed", async () => {
  const f = assetPublicFixture(),
    original = new Error("unknown outcome");
  let calls = 0;
  const failed = createPluginProjectAssetUiClient(
    {
      async invoke() {
        calls++;
        throw original;
      },
    },
    projectAssetsUiCodec,
  );
  await assert.rejects(
    failed.saveCandidate(f.request.input),
    (error) => error === original,
  );
  assert.equal(calls, 1);
  const malformed = createPluginProjectAssetUiClient(
    {
      async invoke() {
        return { ...f.response, asset: { ...f.asset, projectId: "foreign" } };
      },
    },
    projectAssetsUiCodec,
  );
  await assert.rejects(malformed.saveCandidate(f.request.input));
});
