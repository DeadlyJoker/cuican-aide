import {
  registerProjectGenerationHostAvailability,
  hasProjectGenerationHostAvailability,
} from "./plugin-project-generation-host-availability.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  uiTestDescriptor,
  uiTestScope,
  uiTestDigest,
} from "../../application/src/plugin-ui.test-support.ts";
import { appendProjectMediaInputUiServiceAvailability } from "./plugin-project-media-input-host-service-availability.ts";
import {
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
} from "./plugin-ui-host-service-availability.ts";
import { createDeferredPluginUiHostServiceAvailability } from "./plugin-ui-deferred-host-service-availability.ts";

test("media availability extends only its explicit @1 owner and preserves deferred original capabilities", () => {
  const deferred = createDeferredPluginUiHostServiceAvailability();
  let media = true;
  const services = appendProjectMediaInputUiServiceAvailability({
    mediaInputs: { isAvailable: () => media },
    fallback: deferred.port,
  });
  const original = registerProjectGenerationHostAvailability(
    Object.freeze({ isAvailable: () => true }),
  );
  deferred.bind(original);
  assert.equal(hasProjectGenerationHostAvailability(services), true);
  for (const optional of [true, false]) {
    const descriptor = parsePluginPackageDescriptor({
      ...uiTestDescriptor,
      entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
      files: uiTestDescriptor.files.filter((f) => f.path === "ui.mjs"),
      requires: [
        { service: "crewon.project-media-inputs", apiVersion: "1", optional },
      ],
    });
    const request = {
      scope: uiTestScope,
      candidate: { descriptor, packageDigest: uiTestDigest },
      hostUiServices: services,
    };
    assertUiOnlyServiceDeclarations(descriptor, services);
    assertPluginUiHostServiceAvailability(request);
    media = false;
    if (optional) assertPluginUiHostServiceAvailability(request);
    else
      assert.throws(() => assertPluginUiHostServiceAvailability(request), {
        code: "plugin_dependency_unavailable",
      });
    media = true;
    assert.equal(
      services.isAvailable({
        ...request,
        requirement: {
          service: "crewon.project-media-inputs",
          apiVersion: "2",
          optional,
        },
      }),
      false,
    );
  }
  deferred.close();
  assert.equal(hasProjectGenerationHostAvailability(services), false);
});
