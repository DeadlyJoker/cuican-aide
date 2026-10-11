import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePluginNodeHostServiceCatalog,
  type PluginNodeHostServiceRegistration,
} from "./plugin-node-host-service-catalog.ts";

const registration = (
  service = "host.fixture",
  apiVersion = "1",
): PluginNodeHostServiceRegistration => ({
  metadata: {
    service,
    apiVersion,
    implementationId: "host.fixture-implementation",
    implementationRevision: 1,
  },
  implementation: {
    service,
    apiVersion,
    value: Object.freeze({ observe() {} }),
  },
});

test("one immutable catalog keeps original service owners aligned with canonical identity order", () => {
  const first = registration("host.z", "2");
  const second = registration("host.a", "1");
  const input = [first, second];
  const catalog = capturePluginNodeHostServiceCatalog(input);
  assert.deepEqual(
    catalog.metadata.map((entry) => [entry.service, entry.apiVersion]),
    [
      ["host.a", "1"],
      ["host.z", "2"],
    ],
  );
  assert.equal(catalog.implementations[0]!.value, second.implementation.value);
  assert.equal(catalog.implementations[1]!.value, first.implementation.value);
  assert.equal(catalog.registrations[0]!.metadata, catalog.metadata[0]);
  assert.equal(
    catalog.registrations[1]!.implementation,
    catalog.implementations[1],
  );
  input.length = 0;
  (
    first.metadata as { implementationRevision: number }
  ).implementationRevision = 9;
  (first.implementation as { service: string }).service = "host.replaced";
  assert.equal(catalog.metadata[1]!.implementationRevision, 1);
  assert.equal(catalog.implementations[1]!.service, "host.z");
  for (const value of [
    catalog,
    catalog.registrations,
    catalog.metadata,
    catalog.implementations,
    ...catalog.registrations,
    ...catalog.metadata,
    ...catalog.implementations,
  ])
    assert.ok(Object.isFrozen(value));
});

test("catalog captures the exact binding method and original receiver without freezing mutable service state", () => {
  let calls = 0;
  const entry = registration();
  const value = { calls: 0 };
  const implementation = {
    ...entry.implementation,
    value,
    bindForPlugin() {
      assert.equal(this, implementation);
      calls++;
      this.value.calls++;
      return this.value;
    },
  };
  const catalog = capturePluginNodeHostServiceCatalog([
    { metadata: entry.metadata, implementation },
  ]);
  implementation.bindForPlugin = () => {
    throw new Error("replaced");
  };
  const bound = catalog.implementations[0]!.bindForPlugin!(
    { pluginId: "example", version: "1.0.0", packageDigest: "digest" },
    { onDispose() {} },
  );
  assert.equal(bound, value);
  assert.equal(value.calls, 1);
  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(value), false);
});

test("metadata cannot be paired with a different Node service or API, including crossed entries", () => {
  const left = registration("host.left");
  const right = registration("host.right");
  for (const entries of [
    [{ ...left, implementation: right.implementation }],
    [
      { ...left, implementation: right.implementation },
      { ...right, implementation: left.implementation },
    ],
    [
      {
        ...left,
        implementation: { ...left.implementation, apiVersion: "2" },
      },
    ],
  ])
    assert.throws(() => capturePluginNodeHostServiceCatalog(entries), {
      code: "plugin_host_service_catalog_identity_conflict",
    });
});

test("duplicate identities, invalid revisions and hidden metadata are rejected", () => {
  const entry = registration();
  assert.throws(() => capturePluginNodeHostServiceCatalog([entry, entry]), {
    code: "plugin_composition_service_conflict",
  });
  for (const metadata of [
    { ...entry.metadata, implementationRevision: 0 },
    { ...entry.metadata, implementationRevision: 1.5 },
    { ...entry.metadata, implementationId: "" },
    Object.defineProperty({ ...entry.metadata }, "secret", { value: true }),
  ])
    assert.throws(() =>
      capturePluginNodeHostServiceCatalog([{ ...entry, metadata }]),
    );
});

test("registration, implementation and array getters are rejected without running getters", () => {
  const entry = registration();
  let getters = 0;
  const getter = () => {
    getters++;
    return entry.implementation;
  };
  const accessorEntry = Object.defineProperty(
    { metadata: entry.metadata },
    "implementation",
    {
      enumerable: true,
      get: getter,
    },
  );
  const accessorService = Object.defineProperty(
    { ...entry.implementation },
    "bindForPlugin",
    {
      enumerable: true,
      get: getter,
    },
  );
  const accessorMetadata = Object.defineProperty(
    { ...entry.metadata },
    "service",
    {
      enumerable: true,
      get: getter,
    },
  );
  const array = [entry];
  Object.defineProperty(array, "0", { enumerable: true, get: getter });
  for (const value of [
    [accessorEntry],
    [{ ...entry, implementation: accessorService }],
    [{ ...entry, metadata: accessorMetadata }],
    array,
  ])
    assert.throws(() =>
      capturePluginNodeHostServiceCatalog(
        value as readonly PluginNodeHostServiceRegistration[],
      ),
    );
  assert.equal(getters, 0);
});

test("only bounded plain arrays of real object values enter the Node catalog", () => {
  const entry = registration();
  const sparse = new Array(1);
  const hidden = Object.defineProperty([entry], "hidden", { value: true });
  const symbol = Object.assign([entry], { [Symbol.iterator]: () => [] });
  const custom = Object.setPrototypeOf([entry], {});
  for (const value of [
    sparse,
    hidden,
    symbol,
    custom,
    new Array(1025).fill(entry),
  ])
    assert.throws(() => capturePluginNodeHostServiceCatalog(value), {
      code: "plugin_host_service_catalog_invalid",
    });
  for (const value of [null, [], false, "available", () => {}])
    assert.throws(() =>
      capturePluginNodeHostServiceCatalog([
        {
          ...entry,
          implementation: { ...entry.implementation, value: value as object },
        },
      ]),
    );
  const empty = capturePluginNodeHostServiceCatalog([]);
  assert.deepEqual(empty, {
    registrations: [],
    metadata: [],
    implementations: [],
  });
});
