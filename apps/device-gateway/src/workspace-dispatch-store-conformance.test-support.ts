import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceWorkspaceListCommand,
  DeviceWorkspaceListDispatchResolution,
  DeviceWorkspaceListEvent,
  DeviceWorkspaceListPeerRoute,
} from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  parseWorkspaceDispatchAuthorityRecord,
  workspaceDispatchFingerprint,
  type WorkspaceDispatchAuthorityRecord,
  type WorkspaceDispatchStorePort,
} from "./workspace-dispatch-store.ts";
import {
  acceptedEvent,
  acknowledgement,
  command,
  completedEvent,
  completedResolution,
  hasCode,
  route,
  timestamp,
} from "./workspace-dispatch-store-conformance-fixtures.test-support.ts";
export {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
  route,
} from "./workspace-dispatch-store-conformance-fixtures.test-support.ts";
export type WorkspaceDispatchStoreFactory = (
  options?: Readonly<{
    initialRecords?: readonly WorkspaceDispatchAuthorityRecord[];
    currentRoute?: DeviceWorkspaceListPeerRoute | null;
    now?: string;
  }>,
) => WorkspaceDispatchStorePort;

export function runWorkspaceDispatchStoreConformance(
  adapterName: string,
  factory: WorkspaceDispatchStoreFactory,
): void {
  test(`${adapterName}: freezes the exact signed command and replays before mutable route state`, async () => {
    const store = factory();
    const first = await store.prepare(command(), timestamp(0));
    assert.equal(first.outcome, "created");
    assert.deepEqual(first.record.command, command());
    assert.equal(
      first.record.fingerprint,
      workspaceDispatchFingerprint(command()),
    );

    const replay = await store.prepare(command(), timestamp(60 * 60));
    assert.deepEqual(replay, { outcome: "existing", record: first.record });
    await assert.rejects(
      store.prepare(
        command({
          authorization: {
            ...command().authorization,
            signature: "B".repeat(86),
          },
        }),
        timestamp(1),
      ),
      hasCode("workspace_dispatch_identity_conflict"),
    );
    assert.deepEqual(await store.load(command().executionId), first.record);
    await store.close();
  });

  test(`${adapterName}: commits accepted event before exposing ACK authority`, async () => {
    const store = factory();
    await store.prepare(command(), timestamp(0));
    const committed = await store.acceptEvent({
      command: command(),
      route: route(),
      event: acceptedEvent(),
    });
    assert.equal(committed.outcome, "committed");
    assert.deepEqual(committed.record, await store.load(command().executionId));
    assert.deepEqual(committed.acknowledgement, acknowledgement(1));

    const replay = await store.acceptEvent({
      command: command(),
      route: route(),
      event: acceptedEvent(),
    });
    assert.deepEqual(replay, { ...committed, outcome: "replayed" });
    await assert.rejects(
      store.acceptEvent({
        command: command(),
        route: route(),
        event: acceptedEvent({ receiptId: "workspace-receipt-other" }),
      }),
      hasCode("workspace_dispatch_event_conflict"),
    );
    await assert.rejects(
      store.acceptEvent({
        command: command(),
        route: route(),
        event: acceptedEvent({ connectionEpoch: 4 }),
      }),
      hasCode("device_workspace_event_identity_mismatch"),
    );
    assert.deepEqual(await store.load(command().executionId), committed.record);
    await store.close();
  });

  test(`${adapterName}: treats route lease as a canonical half-open time fence`, async () => {
    const beforeExpiry = factory({ now: "2026-08-09T00:04:59.999Z" });
    await beforeExpiry.prepare(command(), timestamp(0));
    assert.equal(
      (
        await beforeExpiry.acceptEvent({
          command: command(),
          route: route(),
          event: acceptedEvent(),
        })
      ).outcome,
      "committed",
    );
    await beforeExpiry.close();

    const atExpiry = factory({ now: route().leaseExpiresAt });
    await atExpiry.prepare(command(), timestamp(0));
    await assert.rejects(
      atExpiry.acceptEvent({
        command: command(),
        route: route(),
        event: acceptedEvent(),
      }),
      hasCode("workspace_dispatch_route_expired"),
    );
    assert.equal(
      (await atExpiry.load(command().executionId))?.acceptedEvent,
      null,
    );
    await atExpiry.close();

    const nonCanonical = factory();
    await assert.rejects(
      nonCanonical.prepare(command(), "2026-08-09T00:00:00Z"),
      hasCode("workspace_dispatch_timestamp_invalid"),
    );
    assert.equal(await nonCanonical.load(command().executionId), null);
    await nonCanonical.close();
  });

  test(`${adapterName}: accepts only the internal current route and rejects caller time authority`, async () => {
    const wrongExpectedRoute = factory();
    await wrongExpectedRoute.prepare(command(), timestamp(0));
    await assert.rejects(
      wrongExpectedRoute.acceptEvent({
        command: command(),
        route: { ...route(), connectionId: "connection-caller" },
        event: acceptedEvent(),
      }),
      hasCode("workspace_dispatch_route_stale"),
    );
    await assert.rejects(
      wrongExpectedRoute.acceptEvent({
        command: command(),
        route: route(),
        event: acceptedEvent(),
        committedAt: "2026-08-09T00:00:00.000Z",
      } as never),
      hasCode("workspace_dispatch_fields_invalid"),
    );
    assert.equal(
      (await wrongExpectedRoute.load(command().executionId))?.acceptedEvent,
      null,
    );
    await wrongExpectedRoute.close();

    const oldCurrentRoute = factory({
      currentRoute: { ...route(), connectionEpoch: 2 },
    });
    await oldCurrentRoute.prepare(command(), timestamp(0));
    await assert.rejects(
      oldCurrentRoute.acceptEvent({
        command: command(),
        route: route(),
        event: acceptedEvent(),
      }),
      hasCode("workspace_dispatch_route_stale"),
    );
    await oldCurrentRoute.close();
  });

  test(`${adapterName}: accepts a same-fence route renewed after dispatch`, async () => {
    const renewedRoute = {
      ...route(),
      leaseExpiresAt: "2026-08-09T00:10:00.000Z",
    };
    const store = factory({ currentRoute: renewedRoute });
    await store.prepare(command(), timestamp(0));
    const committed = await store.acceptEvent({
      command: command(),
      route: route(),
      event: acceptedEvent(),
    });
    assert.deepEqual(committed.record.route, renewedRoute);
    await store.close();
  });

  test(`${adapterName}: atomically commits terminal event and exact resolution`, async () => {
    const store = factory();
    await store.prepare(command(), timestamp(0));
    await store.acceptEvent({
      command: command(),
      route: route(),
      event: acceptedEvent(),
    });
    const committed = await store.settleEvent({
      command: command(),
      route: route(),
      event: completedEvent(),
      resolution: completedResolution(),
    });
    assert.equal(committed.outcome, "committed");
    assert.deepEqual(committed.acknowledgement, acknowledgement(2));
    assert.deepEqual(committed.record, await store.load(command().executionId));

    const replay = await store.settleEvent({
      command: command(),
      route: route(),
      event: completedEvent(),
      resolution: completedResolution(),
    });
    assert.deepEqual(replay, { ...committed, outcome: "replayed" });

    const changedEvent = completedEvent({
      data: {
        result: {
          ...completedEvent().data.result,
          entries: [{ name: "changed", kind: "file" }],
        },
      },
    });
    await assert.rejects(
      store.settleEvent({
        command: command(),
        route: route(),
        event: changedEvent,
        resolution: {
          ...completedResolution(),
          terminal: changedEvent,
        },
      }),
      hasCode("workspace_dispatch_terminal_conflict"),
    );
    assert.deepEqual(await store.load(command().executionId), committed.record);
    await store.close();
  });

  test(`${adapterName}: settles after accepted lease expiry through a stable renewed route fence`, async () => {
    const first = factory();
    await first.prepare(command(), timestamp(0));
    await first.acceptEvent({
      command: command(),
      route: route(),
      event: acceptedEvent(),
    });
    const accepted = await first.load(command().executionId);
    assert.notEqual(accepted, null);
    await first.close();

    const renewedRoute = {
      ...route(),
      leaseExpiresAt: "2099-01-01T00:05:00.000Z",
    };
    const afterExpiry = factory({
      initialRecords: [accepted!],
      currentRoute: null,
      now: "2099-01-01T00:00:00.000Z",
    });
    const terminal = await afterExpiry.settleEvent({
      command: command(),
      route: renewedRoute,
      event: completedEvent(),
      resolution: completedResolution(),
    });
    assert.equal(terminal.outcome, "committed");
    assert.deepEqual(terminal.record.route, route());
    await afterExpiry.close();
  });

  test(`${adapterName}: rejects terminal-before-accepted and corrupt event authority without partial mutation`, async () => {
    const store = factory();
    const prepared = await store.prepare(command(), timestamp(0));
    await assert.rejects(
      store.settleEvent({
        command: command(),
        route: route(),
        event: completedEvent(),
        resolution: completedResolution(),
      }),
      hasCode("workspace_dispatch_accepted_missing"),
    );
    assert.deepEqual(await store.load(command().executionId), prepared.record);

    await store.acceptEvent({
      command: command(),
      route: route(),
      event: acceptedEvent(),
    });
    await assert.rejects(
      store.settleEvent({
        command: command(),
        route: route(),
        event: completedEvent({ receiptId: "workspace-receipt-other" }),
        resolution: completedResolution(),
      }),
      hasCode("workspace_dispatch_terminal_conflict"),
    );
    const backwardEvent = completedEvent({
      observedAt: "2026-08-08T23:59:59.999Z",
    });
    await assert.rejects(
      store.settleEvent({
        command: command(),
        route: route(),
        event: backwardEvent,
        resolution: {
          ...completedResolution(),
          terminal: backwardEvent,
        },
      }),
      hasCode("workspace_dispatch_authority_corrupt"),
    );
    const accepted = await store.load(command().executionId);
    assert.equal(accepted?.terminalEvent, null);
    assert.equal(accepted?.resolution, null);
    await store.close();
  });

  test(`${adapterName}: deep-validates terminal restart clones and replays after signature expiry`, async () => {
    const first = factory();
    await first.prepare(command(), timestamp(0));
    await first.acceptEvent({
      command: command(),
      route: route(),
      event: acceptedEvent(),
    });
    await first.settleEvent({
      command: command(),
      route: route(),
      event: completedEvent(),
      resolution: completedResolution(),
    });
    const terminal = await first.load(command().executionId);
    assert.notEqual(terminal, null);
    await first.close();

    const restarted = factory({
      initialRecords: [structuredClone(terminal!)],
      now: "2099-01-01T00:00:01.000Z",
    });
    assert.deepEqual(await restarted.load(command().executionId), terminal);
    assert.deepEqual(
      (await restarted.prepare(command(), "2099-01-01T00:00:00.000Z")).record,
      terminal,
    );
    const replay = await restarted.settleEvent({
      command: command(),
      route: route(),
      event: completedEvent(),
      resolution: completedResolution(),
    });
    assert.equal(replay.outcome, "replayed");

    assert.throws(
      () =>
        parseWorkspaceDispatchAuthorityRecord({
          ...terminal,
          terminalEvent: {
            ...terminal!.terminalEvent,
            runtimeBindingId: "runtime-binding-substituted",
          },
        }),
      hasCode("device_workspace_event_identity_mismatch"),
    );
    assert.throws(
      () =>
        parseWorkspaceDispatchAuthorityRecord({
          ...terminal,
          resolution: null,
        }),
      hasCode("workspace_dispatch_authority_corrupt"),
    );
    assert.throws(
      () =>
        parseWorkspaceDispatchAuthorityRecord({
          ...terminal,
          acceptedEvent: {
            ...terminal!.acceptedEvent,
            receiptId: "workspace-receipt-substituted",
          },
        }),
      hasCode("workspace_dispatch_authority_corrupt"),
    );
    await restarted.close();
  });
}
