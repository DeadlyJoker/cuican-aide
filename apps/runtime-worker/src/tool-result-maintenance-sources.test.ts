import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { externalResourceLease } from "./runtime-resource-lease.ts";
import { toolResultMaintenanceSources } from "./tool-result-maintenance-sources.ts";

test("maintenance without an installed capability preserves the exact original source", () => {
  const base = () => externalResourceLease(new InMemoryToolBroker());
  assert.equal(toolResultMaintenanceSources({ base }), base);
});

test("maintenance alternates actual installed and original owners without acquiring an unused lease", () => {
  const visits: string[] = [];
  const base = new InMemoryToolBroker();
  const installed = new InMemoryToolBroker();
  const select = toolResultMaintenanceSources({
    base: () => {
      visits.push("base");
      return externalResourceLease(base);
    },
    installed: () => {
      visits.push("installed");
      return externalResourceLease(installed);
    },
  });
  assert.equal(select()?.resource, installed);
  assert.equal(select()?.resource, base);
  assert.equal(select()?.resource, installed);
  assert.equal(select()?.resource, base);
  assert.deepEqual(visits, ["installed", "base", "installed", "base"]);
});

test("an empty admitted owner set visits only the bounded two sources and still maintains the original runtime", () => {
  const visits: string[] = [];
  const base = new InMemoryToolBroker();
  const select = toolResultMaintenanceSources({
    base: () => {
      visits.push("base");
      return externalResourceLease(base);
    },
    installed: () => {
      visits.push("installed");
      return null;
    },
  });
  for (let pass = 0; pass < 4; pass++) assert.equal(select()?.resource, base);
  assert.deepEqual(visits, [
    "installed",
    "base",
    "base",
    "installed",
    "base",
    "base",
  ]);
});

test("an empty original set cannot starve installed receipt maintenance and closed sources return no lease", () => {
  let visits = 0;
  const installed = new InMemoryToolBroker();
  let closed = false;
  const select = toolResultMaintenanceSources({
    base: () => {
      visits++;
      return null;
    },
    installed: () => {
      visits++;
      return closed ? null : externalResourceLease(installed);
    },
  });
  assert.equal(select()?.resource, installed);
  assert.equal(select()?.resource, installed);
  closed = true;
  assert.equal(select(), null);
  assert.equal(visits, 5);
});
