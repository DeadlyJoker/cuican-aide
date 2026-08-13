import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import { legacyDomainClientForAuthority } from "./legacyDomainAuthority";

describe("legacy Office and Automation authority", () => {
  const legacyClient = {} as AppServerClient;

  it("fails closed when Control authority is configured", () => {
    expect(
      legacyDomainClientForAuthority({
        controlClientConfigured: true,
        legacyClient,
      }),
    ).toBeNull();
  });

  it("keeps legacy domain behavior when Control is not configured", () => {
    expect(
      legacyDomainClientForAuthority({
        controlClientConfigured: false,
        legacyClient,
      }),
    ).toBe(legacyClient);
  });
});
