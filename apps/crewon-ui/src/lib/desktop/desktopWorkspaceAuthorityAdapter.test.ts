import { describe, expect, it, vi } from "vitest";

import {
  createDesktopWorkspaceAuthorityAdapter,
  DesktopWorkspaceAuthorityConflictError,
  DesktopWorkspaceNativeMutationError,
  DesktopWorkspaceProtocolError,
  DesktopWorkspaceTransitioningError,
  DesktopWorkspaceUnavailableError,
  DesktopWorkspaceUnknownOutcomeError,
  type DesktopWorkspaceStatus,
} from "./desktopWorkspaceAuthorityAdapter";

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const request = {
  expectedRevision: 4,
  idempotencyKey: "workspace-select:test-key",
} as const;

describe("desktopWorkspaceAuthorityAdapter", () => {
  it("parses only the redacted exact status wire", async () => {
    const expected = status({ current: { displayName: "cuican-aide" } });
    const invoke = vi.fn<Invoke>().mockResolvedValue(expected);

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).status(),
    ).resolves.toEqual(expected);
    expect(invoke.mock.calls).toEqual([["desktop_workspace_status"]]);

    for (const malformed of [
      { ...expected, trustedPath: "/Users/private/project" },
      { ...expected, revision: 4.5 },
      { ...expected, supervisorGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...expected, current: { displayName: "file:///Users/private" } },
      { ...expected, current: { displayName: "C:\\private\\project" } },
      {
        ...expected,
        current: { displayName: "project", workspaceBindingId: "private" },
      },
    ]) {
      const malformedInvoke = vi.fn<Invoke>().mockResolvedValue(malformed);
      await expect(
        createDesktopWorkspaceAuthorityAdapter(malformedInvoke).status(),
      ).rejects.toBeInstanceOf(DesktopWorkspaceProtocolError);
    }
  });

  it("enforces UTF-8 display-name and status wire caps", async () => {
    const accepted = status({ current: { displayName: "界".repeat(85) } });
    await expect(
      createDesktopWorkspaceAuthorityAdapter(
        vi.fn<Invoke>().mockResolvedValue(accepted),
      ).status(),
    ).resolves.toEqual(accepted);

    for (const malformed of [
      status({ current: { displayName: "界".repeat(86) } }),
      {
        ...status(),
        padding: "x".repeat(4 * 1024),
      },
    ]) {
      await expect(
        createDesktopWorkspaceAuthorityAdapter(
          vi.fn<Invoke>().mockResolvedValue(malformed),
        ).status(),
      ).rejects.toBeInstanceOf(DesktopWorkspaceProtocolError);
    }
  });

  it("sends select intent without a renderer path and accepts a committed snapshot", async () => {
    const after = status({
      revision: 5,
      supervisorGeneration: 8,
      current: { displayName: "selected-project" },
    });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce({ outcome: "committed", snapshot: after });

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).resolves.toEqual({ outcome: "committed", snapshot: after });
    expect(invoke.mock.calls).toEqual([
      ["desktop_workspace_status"],
      ["desktop_workspace_select_and_register", { request }],
    ]);
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(
      /(?:path|uri|workspaceBinding|deviceBinding|runtimeBinding|incarnation)/iu,
    );
  });

  it("treats a native directory-dialog cancellation as a stable non-error", async () => {
    const before = status({ current: { displayName: "current-project" } });
    const after = status({
      current: { displayName: "current-project" },
      supervisorGeneration: 8,
    });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({ outcome: "userCanceled", snapshot: after });

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).resolves.toEqual({ outcome: "userCanceled", snapshot: after });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["catalog revision", status({ revision: 5 })],
    ["current Workspace", status({ current: { displayName: "forged" } })],
    ["authority availability", status({ availability: "transitioning" })],
  ])(
    "rejects a user-canceled response that changes %s",
    async (_, snapshot) => {
      const before = status({ current: null });
      const invoke = vi
        .fn<Invoke>()
        .mockResolvedValueOnce(before)
        .mockResolvedValue({ outcome: "userCanceled", snapshot });

      await expect(
        createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(
          request,
        ),
      ).rejects.toBeInstanceOf(DesktopWorkspaceUnknownOutcomeError);
      expect(
        invoke.mock.calls.filter(
          ([command]) => command === "desktop_workspace_select_and_register",
        ),
      ).toHaveLength(2);
    },
  );

  it("accepts only a committed cleared snapshot from clear", async () => {
    const after = status({ revision: 5, current: null });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status({ current: { displayName: "project" } }))
      .mockResolvedValueOnce({ outcome: "committed", snapshot: after });

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).clear({
        ...request,
        idempotencyKey: "workspace-clear:test-key",
      }),
    ).resolves.toEqual({ outcome: "committed", snapshot: after });
    expect(invoke.mock.calls).toEqual([
      ["desktop_workspace_status"],
      [
        "desktop_workspace_clear",
        {
          request: {
            expectedRevision: 4,
            idempotencyKey: "workspace-clear:test-key",
          },
        },
      ],
    ]);
  });

  it("keeps an impossible clear response unknown after its exact retry", async () => {
    const before = status({ current: { displayName: "project" } });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(before)
      .mockResolvedValue({ outcome: "userCanceled", snapshot: before });

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).clear({
        ...request,
        idempotencyKey: "workspace-clear:test-key",
      }),
    ).rejects.toBeInstanceOf(DesktopWorkspaceUnknownOutcomeError);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "desktop_workspace_clear",
      ),
    ).toHaveLength(2);
  });

  it.each([
    ["unavailable", DesktopWorkspaceUnavailableError],
    ["transitioning", DesktopWorkspaceTransitioningError],
  ] as const)(
    "does not issue a mutation while native authority is %s",
    async (availability, errorType) => {
      const invoke = vi
        .fn<Invoke>()
        .mockResolvedValue(status({ availability }));
      const adapter = createDesktopWorkspaceAuthorityAdapter(invoke);

      await expect(adapter.selectAndRegister(request)).rejects.toBeInstanceOf(
        errorType,
      );
      await expect(
        adapter.clear({ ...request, idempotencyKey: "workspace-clear:key" }),
      ).rejects.toBeInstanceOf(errorType);
      expect(invoke.mock.calls).toEqual([
        ["desktop_workspace_status"],
        ["desktop_workspace_status"],
      ]);
    },
  );

  it("fails a stale local CAS against the fresh status without invoking mutation", async () => {
    const current = status({ revision: 9 });
    const invoke = vi.fn<Invoke>().mockResolvedValue(current);

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).rejects.toEqual(new DesktopWorkspaceAuthorityConflictError(current));
    expect(invoke.mock.calls).toEqual([["desktop_workspace_status"]]);
  });

  it("retries one unknown outcome with the identical command and key", async () => {
    const after = status({
      revision: 5,
      current: { displayName: "project" },
    });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status())
      .mockRejectedValueOnce(new TypeError("ipc response lost"))
      .mockResolvedValueOnce({ outcome: "committed", snapshot: after });

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).resolves.toEqual({ outcome: "committed", snapshot: after });
    expect(invoke.mock.calls.slice(1)).toEqual([
      ["desktop_workspace_select_and_register", { request }],
      ["desktop_workspace_select_and_register", { request }],
    ]);
  });

  it("retries an exact possibly-sent error once with the identical key", async () => {
    const after = status({
      revision: 5,
      current: { displayName: "project" },
    });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status())
      .mockRejectedValueOnce(
        nativeError({
          status: 503,
          code: "desktop_workspace_response_lost",
          certainty: "possiblySent",
        }),
      )
      .mockResolvedValueOnce({ outcome: "committed", snapshot: after });

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).resolves.toEqual({ outcome: "committed", snapshot: after });
    expect(invoke.mock.calls.slice(1)).toEqual([
      ["desktop_workspace_select_and_register", { request }],
      ["desktop_workspace_select_and_register", { request }],
    ]);
  });

  it.each([
    {
      first: new TypeError("first transport response lost"),
      name: "not-sent",
      retry: nativeError({
        status: 503,
        code: "desktop_workspace_supervisor_unavailable",
        certainty: "notSent",
      }),
      retryKind: "reject" as const,
    },
    {
      first: nativeError({
        status: 503,
        code: "desktop_workspace_response_lost",
        certainty: "possiblySent",
      }),
      name: "authority conflict",
      retry: nativeError({
        status: 409,
        code: "desktop_workspace_authority_conflict",
        certainty: "notSent",
      }),
      retryKind: "reject" as const,
    },
    {
      first: new TypeError("first transport response lost"),
      name: "transitioning",
      retry: nativeError({
        status: 409,
        code: "desktop_workspace_transitioning",
        certainty: "notSent",
      }),
      retryKind: "reject" as const,
    },
    {
      first: nativeError({
        status: 503,
        code: "desktop_workspace_response_lost",
        certainty: "possiblySent",
      }),
      name: "unavailable",
      retry: nativeError({
        status: 503,
        code: "desktop_workspace_unavailable",
        certainty: "notSent",
      }),
      retryKind: "reject" as const,
    },
    {
      first: new TypeError("first transport response lost"),
      name: "malformed success",
      retry: {
        outcome: "committed",
        snapshot: {
          ...status({
            current: { displayName: "project" },
            revision: 5,
          }),
          trustedPath: "/private",
        },
      },
      retryKind: "resolve" as const,
    },
  ])(
    "keeps the first unknown outcome sticky when its retry is $name",
    async ({ first, retry, retryKind }) => {
      const invoke = vi
        .fn<Invoke>()
        .mockResolvedValueOnce(status())
        .mockRejectedValueOnce(first);
      if (retryKind === "reject") {
        invoke.mockRejectedValueOnce(retry);
      } else {
        invoke.mockResolvedValueOnce(retry);
      }

      await expect(
        createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(
          request,
        ),
      ).rejects.toBeInstanceOf(DesktopWorkspaceUnknownOutcomeError);
      expect(invoke.mock.calls).toEqual([
        ["desktop_workspace_status"],
        ["desktop_workspace_select_and_register", { request }],
        ["desktop_workspace_select_and_register", { request }],
      ]);
    },
  );

  it("retries a malformed success with the same key and accepts its valid receipt replay", async () => {
    const after = status({
      revision: 5,
      current: { displayName: "project" },
    });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce({
        outcome: "committed",
        snapshot: { ...after, trustedPath: "/private" },
      })
      .mockResolvedValueOnce({ outcome: "committed", snapshot: after });

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).resolves.toEqual({ outcome: "committed", snapshot: after });
    expect(invoke.mock.calls.slice(1)).toEqual([
      ["desktop_workspace_select_and_register", { request }],
      ["desktop_workspace_select_and_register", { request }],
    ]);
  });

  it.each([
    {
      name: "not-sent",
      retry: nativeError({
        status: 503,
        code: "desktop_workspace_supervisor_unavailable",
        certainty: "notSent",
      }),
      retryKind: "reject" as const,
    },
    {
      name: "authority conflict",
      retry: nativeError({
        status: 409,
        code: "desktop_workspace_authority_conflict",
        certainty: "notSent",
      }),
      retryKind: "reject" as const,
    },
    {
      name: "another malformed success",
      retry: {
        outcome: "committed",
        snapshot: {
          ...status({
            current: { displayName: "project" },
            revision: 5,
          }),
          runtimeBindingId: "forged",
        },
      },
      retryKind: "resolve" as const,
    },
  ])(
    "keeps a malformed first success unknown when its retry is $name",
    async ({ retry, retryKind }) => {
      const malformedFirst = {
        outcome: "committed",
        snapshot: {
          ...status({
            current: { displayName: "project" },
            revision: 5,
          }),
          trustedPath: "/private",
        },
      };
      const invoke = vi
        .fn<Invoke>()
        .mockResolvedValueOnce(status())
        .mockResolvedValueOnce(malformedFirst);
      if (retryKind === "reject") {
        invoke.mockRejectedValueOnce(retry);
      } else {
        invoke.mockResolvedValueOnce(retry);
      }

      await expect(
        createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(
          request,
        ),
      ).rejects.toBeInstanceOf(DesktopWorkspaceUnknownOutcomeError);
      expect(invoke.mock.calls).toEqual([
        ["desktop_workspace_status"],
        ["desktop_workspace_select_and_register", { request }],
        ["desktop_workspace_select_and_register", { request }],
      ]);
    },
  );

  it("rehydrates once after an exact 409 authority conflict without replaying stale intent", async () => {
    const rehydrated = status({ revision: 5 });
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status())
      .mockRejectedValueOnce(
        nativeError({
          status: 409,
          code: "desktop_workspace_authority_conflict",
          certainty: "notSent",
        }),
      )
      .mockResolvedValueOnce(rehydrated);

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).rejects.toEqual(new DesktopWorkspaceAuthorityConflictError(rehydrated));
    expect(invoke.mock.calls).toEqual([
      ["desktop_workspace_status"],
      ["desktop_workspace_select_and_register", { request }],
      ["desktop_workspace_status"],
    ]);
  });

  it("does not retry an exact not-sent native rejection", async () => {
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status())
      .mockRejectedValueOnce(
        nativeError({
          status: 503,
          code: "desktop_workspace_supervisor_unavailable",
          certainty: "notSent",
        }),
      );

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DesktopWorkspaceNativeMutationError>>({
        status: 503,
        code: "desktop_workspace_supervisor_unavailable",
        certainty: "notSent",
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports unknown after exactly two unprovable outcomes", async () => {
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce(status())
      .mockRejectedValue(new Error("ipc closed"));

    await expect(
      createDesktopWorkspaceAuthorityAdapter(invoke).selectAndRegister(request),
    ).rejects.toBeInstanceOf(DesktopWorkspaceUnknownOutcomeError);
    expect(invoke.mock.calls.slice(1)).toHaveLength(2);
  });

  it("validates mutation intent before any native read", async () => {
    const invoke = vi.fn<Invoke>();
    const adapter = createDesktopWorkspaceAuthorityAdapter(invoke);
    const malformed = [
      { ...request, expectedRevision: -1 },
      { ...request, expectedRevision: 1.5 },
      { ...request, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, idempotencyKey: "界".repeat(86) },
      { ...request, idempotencyKey: "unicode-界" },
      { ...request, idempotencyKey: "invalid/key" },
      { ...request, idempotencyKey: "_invalid-leading-character" },
      { ...request, idempotencyKey: " leading-space" },
      { ...request, idempotencyKey: "control\ncharacter" },
      { ...request, path: "/Users/private/project" },
    ];

    for (const invalid of malformed) {
      await expect(adapter.selectAndRegister(invalid)).rejects.toBeInstanceOf(
        DesktopWorkspaceProtocolError,
      );
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});

function status(
  overrides: Partial<DesktopWorkspaceStatus> = {},
): DesktopWorkspaceStatus {
  return {
    schemaVersion: "crewon.desktop-workspace-status.v0",
    availability: "available",
    revision: 4,
    supervisorGeneration: 7,
    current: null,
    ...overrides,
  };
}

function nativeError(
  overrides: Readonly<{
    status: number;
    code: string;
    certainty: "notSent" | "possiblySent";
  }>,
): unknown {
  return {
    schemaVersion: "crewon.desktop-workspace-error.v0",
    ...overrides,
  };
}
