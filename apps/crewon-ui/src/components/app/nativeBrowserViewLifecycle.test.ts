import { describe, expect, it, vi } from "vitest";

import {
  allocateNativeBrowserViewId,
  startNativeBrowserViewGeneration,
  syncNativeBrowserViewForReveal,
  type NativeBrowserViewClient,
} from "./nativeBrowserViewLifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function clientWithDeferredCreate(createPromise: Promise<void>) {
  const events: string[] = [];
  const client: NativeBrowserViewClient = {
    create: vi.fn(async (id) => {
      events.push(`create:${id}`);
      await createPromise;
      events.push(`created:${id}`);
    }),
    destroy: vi.fn(async (id) => {
      events.push(`destroy:${id}`);
    }),
    setVisible: vi.fn(async (id, visible) => {
      events.push(`visible:${id}:${visible}`);
    }),
    updateBounds: vi.fn(async (id, nextBounds) => {
      events.push(`bounds:${id}:${nextBounds.x}:${nextBounds.width}`);
    }),
  };
  return { client, events };
}

const bounds = { x: 10, y: 20, width: 800, height: 600 };

describe("native browser view lifecycle", () => {
  it("uses a unique bounded id for every async effect generation", () => {
    const first = allocateNativeBrowserViewId("web:one");
    const second = allocateNativeBrowserViewId("web:one");
    const long = allocateNativeBrowserViewId("x".repeat(300));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
    expect(long.length).toBeLessThanOrEqual(128);
  });

  it("applies the latest obscured state after a deferred create without disposing the generation", async () => {
    const pendingCreate = deferred();
    const { client, events } = clientWithDeferredCreate(pendingCreate.promise);
    let obscured = false;
    let currentBounds = bounds;
    const generation = startNativeBrowserViewGeneration({
      browser: client,
      getBounds: () => bounds,
      id: "browser-generation-hidden",
      url: "https://example.test/",
    });

    await vi.waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    obscured = true;
    currentBounds = { ...bounds, x: 240, width: 560 };
    pendingCreate.resolve();

    await expect(generation.completion).resolves.toBe("ready");
    await syncNativeBrowserViewForReveal({
      bounds: currentBounds,
      browser: client,
      id: "browser-generation-hidden",
      isCurrent: () => true,
      isObscured: () => obscured,
    });
    expect(client.updateBounds).toHaveBeenCalledWith(
      "browser-generation-hidden",
      currentBounds,
    );
    expect(client.setVisible).toHaveBeenLastCalledWith(
      "browser-generation-hidden",
      false,
    );
    expect(events).toContain("bounds:browser-generation-hidden:240:560");
    obscured = false;
    await syncNativeBrowserViewForReveal({
      bounds: currentBounds,
      browser: client,
      id: "browser-generation-hidden",
      isCurrent: () => true,
      isObscured: () => obscured,
    });
    expect(client.updateBounds).toHaveBeenCalledTimes(2);
    expect(client.setVisible).toHaveBeenLastCalledWith(
      "browser-generation-hidden",
      true,
    );
    expect(events.filter((event) => event.startsWith("destroy:"))).toHaveLength(
      1,
    );
    await generation.dispose();
  });

  it("updates fresh bounds before revealing an unobscured deferred view", async () => {
    const pendingCreate = deferred();
    const { client, events } = clientWithDeferredCreate(pendingCreate.promise);
    const latestBounds = { ...bounds, x: 320, width: 480 };
    const generation = startNativeBrowserViewGeneration({
      browser: client,
      getBounds: () => bounds,
      id: "browser-generation-reveal",
      url: "https://example.test/",
    });

    await vi.waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    pendingCreate.resolve();
    await expect(generation.completion).resolves.toBe("ready");
    await syncNativeBrowserViewForReveal({
      bounds: latestBounds,
      browser: client,
      id: "browser-generation-reveal",
      isCurrent: () => true,
      isObscured: () => false,
    });

    const boundsIndex = events.indexOf(
      "bounds:browser-generation-reveal:320:480",
    );
    const revealIndex = events.indexOf(
      "visible:browser-generation-reveal:true",
    );
    expect(boundsIndex).toBeGreaterThanOrEqual(0);
    expect(revealIndex).toBeGreaterThan(boundsIndex);
    await generation.dispose();
  });

  it("destroys its own generation when create resolves after disposal", async () => {
    const pendingCreate = deferred();
    const { client, events } = clientWithDeferredCreate(pendingCreate.promise);
    const generation = startNativeBrowserViewGeneration({
      browser: client,
      getBounds: () => bounds,
      id: "browser-generation-disposed",
      url: "https://example.test/",
    });

    await vi.waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    await generation.dispose();
    pendingCreate.resolve();

    await expect(generation.completion).resolves.toBe("disposed");
    expect(client.setVisible).not.toHaveBeenCalled();
    expect(events.slice(-2)).toEqual([
      "created:browser-generation-disposed",
      "destroy:browser-generation-disposed",
    ]);
  });
});
