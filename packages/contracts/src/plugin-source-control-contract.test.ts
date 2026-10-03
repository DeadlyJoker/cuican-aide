import assert from "node:assert/strict";
import test from "node:test";
import * as publicContracts from "./index.ts";
import * as pluginContracts from "./plugins.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginSourceListQuery,
  parsePluginSourceListResponse,
  parsePluginSourceView,
} from "./plugin-source-control-contract.ts";

const first = {
  sourceId: "approved:001",
  pluginId: "fixture.plugin",
  publisherId: "fixture.publisher",
  version: "1.0.0",
  title: "真实来源",
  description: "A verified package\nwhose source remains private.",
  packageDigest: `sha256:${"a".repeat(64)}`,
};
const second = {
  ...first,
  sourceId: "approved:002",
  version: "2.0.0",
  packageDigest: `sha256:${"b".repeat(64)}`,
};
const all = { afterSourceId: null, limit: 50 };
const rejects = (run: () => unknown) =>
  assert.throws(run, (error) => error instanceof ContractValidationError);

test("source HTTP pagination copies own data, defaults to fifty and rejects authority or duplicate values", () => {
  let reads = 0;
  const query = Object.create({
    get limit() {
      reads++;
      return "1";
    },
  });
  Object.defineProperty(query, "afterSourceId", {
    enumerable: true,
    value: "来源:001",
  });
  assert.deepEqual(parsePluginSourceListQuery(query), {
    afterSourceId: "来源:001",
    limit: 50,
  });
  assert.deepEqual(parsePluginSourceListQuery({}), all);
  assert.deepEqual(parsePluginSourceListQuery({ limit: "1" }), {
    afterSourceId: null,
    limit: 1,
  });
  for (const limit of [
    "0",
    "01",
    "51",
    "1.5",
    "1e1",
    " 1",
    1,
    ["1", "2"],
    null,
  ])
    rejects(() => parsePluginSourceListQuery({ limit }));
  for (const value of [
    { afterSourceId: [first.sourceId] },
    { afterSourceId: null },
    { actorId: "forged" },
    { profileId: "forged" },
    { sourcePath: "/private/package" },
    Object.defineProperty({}, "limit", {
      enumerable: true,
      get() {
        reads++;
        return "1";
      },
    }),
    Object.defineProperty({}, "limit", { enumerable: false, value: "1" }),
    { [Symbol("authority")]: "forged" },
  ])
    rejects(() => parsePluginSourceListQuery(value));
  assert.equal(reads, 0);
  assert.ok(Object.isFrozen(parsePluginSourceListQuery(query)));
});

test("source references retain existing opaque install IDs without accepting blanks or malformed Unicode", () => {
  for (const sourceId of ["opaque:source", "源/中文:版本", "x".repeat(128)])
    assert.equal(
      parsePluginSourceView({ ...first, sourceId }).sourceId,
      sourceId,
    );
  for (const sourceId of [
    "",
    " blank",
    "blank ",
    "x".repeat(129),
    "a\n",
    "a\u200b",
    "a\ud800",
  ])
    rejects(() => parsePluginSourceView({ ...first, sourceId }));
});

test("source display metadata preserves descriptor scalar/UTF8 bounds and text rules", () => {
  const title = "😀".repeat(160);
  const description = "剧".repeat(2730) + "AB";
  assert.deepEqual(parsePluginSourceView({ ...first, title, description }), {
    ...first,
    title,
    description,
  });
  for (const title of [
    "😀".repeat(161),
    "line\nbreak",
    "tab\tname",
    " name",
    "name\u2028line",
  ])
    rejects(() => parsePluginSourceView({ ...first, title }));
  for (const description of [
    "剧".repeat(2731),
    "",
    " text ",
    "a\u0000b",
    "a\u200bb",
    "a\ud800b",
  ])
    rejects(() => parsePluginSourceView({ ...first, description }));
  assert.equal(
    parsePluginSourceView({ ...first, description: "a\nb\tc\rd" }).description,
    "a\nb\tc\rd",
  );
});

test("source views enforce exact public identity and never invoke hooks or expose private fields", () => {
  let reads = 0;
  for (const fields of [
    { pluginId: "Invalid" },
    { publisherId: "Invalid" },
    { version: "01.0.0" },
    { packageDigest: "a".repeat(64) },
    { directory: "/private/package" },
    { credential: "secret" },
    { actorId: "forged" },
    { profileId: "forged" },
  ])
    rejects(() => parsePluginSourceView({ ...first, ...fields }));
  const getter = { ...first };
  Object.defineProperty(getter, "title", {
    enumerable: true,
    get() {
      reads++;
      return "title";
    },
  });
  const hidden = Object.defineProperty({ ...first }, "secret", {
    value: "key",
  });
  const hook = {
    ...first,
    toJSON() {
      reads++;
      return first;
    },
  };
  const classValue = Object.assign(Object.create({ inherited: true }), first);
  for (const value of [
    getter,
    hidden,
    hook,
    classValue,
    { ...first, [Symbol("secret")]: "key" },
  ])
    rejects(() => parsePluginSourceView(value));
  assert.equal(reads, 0);
});

test("source pages enforce cursor scope, ascending unique identities and honest continuation", () => {
  assert.deepEqual(
    parsePluginSourceListResponse(
      { sources: [first, second], next: second.sourceId },
      { afterSourceId: null, limit: 2 },
    ),
    {
      sources: [first, second],
      next: second.sourceId,
    },
  );
  assert.deepEqual(
    parsePluginSourceListResponse(
      { sources: [second], next: null },
      { afterSourceId: first.sourceId, limit: 1 },
    ),
    {
      sources: [second],
      next: null,
    },
  );
  for (const value of [
    { sources: [second, first], next: null },
    { sources: [first, first], next: null },
    { sources: [first], next: second.sourceId },
    { sources: [], next: first.sourceId },
    { sources: [first, second], next: "approved:003" },
  ])
    rejects(() =>
      parsePluginSourceListResponse(value, { afterSourceId: null, limit: 2 }),
    );
  rejects(() =>
    parsePluginSourceListResponse(
      { sources: [first], next: null },
      { afterSourceId: first.sourceId, limit: 1 },
    ),
  );
  rejects(() =>
    parsePluginSourceListResponse(
      { sources: [first, second], next: null },
      { afterSourceId: null, limit: 1 },
    ),
  );
  for (const changed of [
    { ...second, version: first.version },
    { ...second, packageDigest: first.packageDigest },
    { ...second, publisherId: "another.publisher" },
  ])
    rejects(() =>
      parsePluginSourceListResponse(
        { sources: [first, changed], next: null },
        all,
      ),
    );
});

test("source responses and normalized context reject undeclared properties, accessors and sparse arrays", () => {
  let reads = 0;
  const sparse = new Array(1);
  const accessor = Object.defineProperty({ next: null }, "sources", {
    enumerable: true,
    get() {
      reads++;
      return [first];
    },
  });
  for (const input of [
    { sources: [first], next: null, profileId: "forged" },
    { sources: sparse, next: null },
    { sources: Object.assign([first], { hidden: true }), next: null },
    accessor,
  ])
    rejects(() => parsePluginSourceListResponse(input, all));
  for (const context of [
    { afterSourceId: null, limit: "50" },
    { afterSourceId: null, limit: 51 },
    { afterSourceId: null, limit: 50, actorId: "forged" },
  ])
    rejects(() =>
      parsePluginSourceListResponse(
        { sources: [], next: null },
        context as unknown as typeof all,
      ),
    );
  assert.equal(reads, 0);
});

test("complete source replies are bounded by encoded 128KiB, copied and deeply frozen", () => {
  const sources = Array.from({ length: 16 }, (_, i) => ({
    ...first,
    sourceId: `approved:${String(i).padStart(3, "0")}`,
    pluginId: `fixture.plugin${i}`,
    description: "x".repeat(8192),
    packageDigest: `sha256:${i.toString(16).padStart(64, "0")}`,
  }));
  const input = { sources: sources.slice(0, 15), next: null };
  const parsed = parsePluginSourceListResponse(input, all);
  assert.equal(parsed.sources.length, 15);
  sources[0]!.title = "mutated";
  input.sources.pop();
  assert.equal(parsed.sources[0]!.title, first.title);
  assert.equal(parsed.sources.length, 15);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.sources));
  assert.ok(Object.isFrozen(parsed.sources[0]));
  rejects(() => parsePluginSourceListResponse({ sources, next: null }, all));
});

test("source management APIs have intentional root exports without entering the plugin execution contract", () => {
  assert.equal(
    publicContracts.parsePluginSourceListQuery,
    parsePluginSourceListQuery,
  );
  assert.equal(
    publicContracts.parsePluginSourceListResponse,
    parsePluginSourceListResponse,
  );
  assert.equal(publicContracts.parsePluginSourceView, parsePluginSourceView);
  assert.equal("parsePluginSourceListQuery" in pluginContracts, false);
});
