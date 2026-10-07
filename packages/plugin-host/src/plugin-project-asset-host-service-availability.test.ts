import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  uiTestDescriptor,
  uiTestScope,
  uiTestDigest,
} from "../../application/src/plugin-ui.test-support.ts";
import {
  appendProjectAssetUiServiceAvailability,
  appendProjectAssetRecoveryUiServiceAvailability,
  appendProjectAssetRecoveryV2UiServiceAvailability,
  appendProjectAssetV2UiServiceAvailability,
} from "./plugin-project-asset-host-service-availability.ts";
import {
  assertUiOnlyServiceDeclarations,
  assertPluginUiHostServiceAvailability,
} from "./plugin-ui-host-service-availability.ts";
import { createDeferredPluginUiHostServiceAvailability } from "./plugin-ui-deferred-host-service-availability.ts";
import {
  registerProjectGenerationHostAvailability,
  hasProjectGenerationHostAvailability,
} from "./plugin-project-generation-host-availability.ts";

test("asset versions have independent owners in either composition order and preserve deferred capabilities", () => {
  for (const reverse of [false, true]) {
    const deferred = createDeferredPluginUiHostServiceAvailability(),
      live = { v1: true, v2: true };
    const a = (fallback: typeof deferred.port) =>
      appendProjectAssetUiServiceAvailability({
        assets: { isAvailable: () => live.v1 },
        fallback,
      });
    const b = (fallback: typeof deferred.port) =>
      appendProjectAssetV2UiServiceAvailability({
        assets: { isAvailable: () => live.v2 },
        fallback,
      });
    const services = reverse ? a(b(deferred.port)) : b(a(deferred.port));
    deferred.bind(
      registerProjectGenerationHostAvailability({
        isAvailable: (r) =>
          r.requirement.service === "crewon.project-generations",
      }),
    );
    assert.equal(hasProjectGenerationHostAvailability(services), true);
    for (const apiVersion of ["1", "2"]) {
      const descriptor = parsePluginPackageDescriptor({
        ...uiTestDescriptor,
        entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
        requires: [
          { service: "crewon.project-assets", apiVersion, optional: false },
        ],
      });
      const request = {
        scope: uiTestScope,
        candidate: { descriptor, packageDigest: uiTestDigest },
        hostUiServices: services,
      };
      assertUiOnlyServiceDeclarations(descriptor, services);
      assert.throws(() => assertUiOnlyServiceDeclarations(descriptor));
      assertPluginUiHostServiceAvailability(request);
      const requirement = descriptor.requires[0]!;
      live.v2 = false;
      assert.equal(
        services.isAvailable({ ...request, requirement }),
        apiVersion === "1",
      );
      if (apiVersion === "2")
        assert.throws(() => assertPluginUiHostServiceAvailability(request));
      live.v2 = true;
      live.v1 = false;
      assert.equal(
        services.isAvailable({ ...request, requirement }),
        apiVersion === "2",
      );
      live.v1 = true;
      for (const unsupported of ["3", "0"])
        assert.equal(
          services.isAvailable({
            ...request,
            requirement: { ...requirement, apiVersion: unsupported },
          }),
          false,
        );
    }
    deferred.close();
    assert.equal(hasProjectGenerationHostAvailability(services), false);
  }
});

test("V2 recovery availability requires its own owner and composes with original recovery", () => {
  for (const reverse of [false, true]) {
    const v1 = (
      fallback?: Parameters<
        typeof appendProjectAssetRecoveryUiServiceAvailability
      >[0]["fallback"],
    ) =>
      appendProjectAssetRecoveryUiServiceAvailability({
        assets: { isAvailable: () => true },
        ...(fallback ? { fallback } : {}),
      });
    const v2 = (
      fallback?: Parameters<
        typeof appendProjectAssetRecoveryV2UiServiceAvailability
      >[0]["fallback"],
    ) =>
      appendProjectAssetRecoveryV2UiServiceAvailability({
        assets: { isAvailable: () => true },
        ...(fallback ? { fallback } : {}),
      });
    const both = reverse ? v1(v2()) : v2(v1());
    for (const apiVersion of ["1", "2"]) {
      const descriptor = parsePluginPackageDescriptor({
        ...uiTestDescriptor,
        entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
        requires: [
          {
            service: "crewon.project-asset-recovery",
            apiVersion,
            optional: false,
          },
        ],
      });
      const r = {
        scope: uiTestScope,
        candidate: { descriptor, packageDigest: uiTestDigest },
        requirement: descriptor.requires[0]!,
      };
      assertUiOnlyServiceDeclarations(descriptor, both);
      assertPluginUiHostServiceAvailability({ ...r, hostUiServices: both });
      assert.equal(v1().isAvailable(r), apiVersion === "1");
      assert.equal(v2().isAvailable(r), apiVersion === "2");
      assert.throws(() => assertUiOnlyServiceDeclarations(descriptor));
    }
  }
});
