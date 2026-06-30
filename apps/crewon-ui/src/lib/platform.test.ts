import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultServerUrl } from "./platform";

function stubLocation(location: {
  host: string;
  hostname: string;
  protocol: "http:" | "https:";
  search: string;
}) {
  vi.stubGlobal("window", { location });
}

describe("platform server URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the Vite websocket proxy for local app-server direct URLs", () => {
    stubLocation({
      host: "127.0.0.1:5175",
      hostname: "127.0.0.1",
      protocol: "http:",
      search: "?server=ws%3A%2F%2F127.0.0.1%3A6176",
    });

    expect(defaultServerUrl()).toBe("ws://127.0.0.1:5175/app-server");
  });

  it("keeps explicit non-local server URLs", () => {
    stubLocation({
      host: "127.0.0.1:5175",
      hostname: "127.0.0.1",
      protocol: "http:",
      search: "?server=wss%3A%2F%2Fremote.example.com%2Fapp-server",
    });

    expect(defaultServerUrl()).toBe("wss://remote.example.com/app-server");
  });
});
