import assert from "node:assert/strict";
import test from "node:test";
import { PimAccountAuthority } from "./pim-account-authority.ts";

const now = Date.parse("2026-10-13T00:00:00Z");
function token(patch: Record<string, unknown> = {}) {
  return `e30.${Buffer.from(
    JSON.stringify({
      sub: "12",
      tenant_id: 8,
      space_id: 9,
      user_role: "user",
      tenant_role: "member",
      space_role: "member",
      type: "access",
      exp: now / 1000 + 3600,
      ...patch,
    }),
  ).toString("base64url")}.c2ln`;
}
function setup(
  input: {
    user?: Record<string, unknown>;
    refreshed?: string;
    status?: number;
  } = {},
) {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const authority = new PimAccountAuthority({
    origin: "http://127.0.0.1:8000",
    now: () => now,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, init });
      return Response.json(
        path.endsWith("/me")
          ? (input.user ?? {
              id: 12,
              is_active: true,
              approval_status: "approved",
              role: "user",
            })
          : { access_token: input.refreshed ?? token() },
        { status: input.status ?? 200 },
      );
    },
  });
  return { authority, calls };
}
const signal = () => new AbortController().signal;

test("uses the authenticated permission authority's current role when the PIM serializer omits it", async () => {
  for (const allowed of [true, false]) {
    const calls: URL[] = [];
    const authority = new PimAccountAuthority({
      origin: "http://127.0.0.1:8000",
      permissionOrigin: "http://127.0.0.1:8010",
      now: () => now,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${token()}`,
        );
        if (url.port === "8010")
          return Response.json({
            allowed,
            reason: "space_role:owner",
            permissions: ["space:read"],
          });
        return Response.json(
          url.pathname.endsWith("/me")
            ? {
                id: 12,
                is_active: true,
                approval_status: "approved",
                role: "user",
              }
            : { access_token: token({ space_role: "viewer" }) },
        );
      },
    });
    if (allowed)
      assert.equal(
        (await authority.verify(token(), signal())).spaceRole,
        "owner",
      );
    else
      await assert.rejects(
        authority.verify(token(), signal()),
        /membership_denied/,
      );
    assert.equal(calls[2]!.searchParams.get("space_id"), "9");
    assert.equal(calls[2]!.searchParams.has("user_id"), false);
  }
});

test("validates the real account and rechecks exactly its original tenant/space membership", async () => {
  const { authority, calls } = setup({
    refreshed: token({ space_role: "viewer" }),
  });
  const result = await authority.verify(token(), signal());
  assert.equal(result.spaceRole, "viewer");
  assert.deepEqual(
    calls.map((x) => x.path),
    ["/api/v1/auth/me", "/api/v1/auth/switch-context"],
  );
  assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), {
    tenant_id: 8,
    space_id: 9,
  });
  assert.equal(calls[0]!.init!.redirect, "error");
});

test("rejects an unverified credential, inactive account and changed user before membership lookup", async () => {
  for (const input of [
    { status: 401 },
    {
      user: {
        id: 13,
        is_active: true,
        approval_status: "approved",
        role: "user",
      },
    },
    {
      user: {
        id: 12,
        is_active: false,
        approval_status: "approved",
        role: "user",
      },
    },
    {
      user: {
        id: 12,
        is_active: true,
        approval_status: "pending",
        role: "user",
      },
    },
  ]) {
    const { authority, calls } = setup(input);
    await assert.rejects(authority.verify(token(), signal()));
    assert.equal(calls.length, 1);
  }
});

test("never adopts a different tenant, space or user from a refreshed response", async () => {
  for (const patch of [{ tenant_id: 10 }, { space_id: 10 }, { sub: "13" }]) {
    const { authority } = setup({ refreshed: token(patch) });
    await assert.rejects(
      authority.verify(token(), signal()),
      /pim_account_scope_mismatch/,
    );
  }
});

test("never authenticates by decoding alone or substitutes missing scope", async () => {
  for (const value of [
    "invalid",
    token({ exp: now / 1000 }),
    token({ tenant_id: null }),
    token({ space_id: 0 }),
    token({ type: "refresh" }),
    token({ sub: "admin" }),
  ]) {
    const { authority, calls } = setup();
    await assert.rejects(authority.verify(value, signal()));
    assert.equal(calls.length, 0);
  }
});

test("rejects non-local plaintext origins and bounded response violations", async () => {
  assert.throws(
    () => new PimAccountAuthority({ origin: "http://identity.example" }),
  );
  const authority = new PimAccountAuthority({
    origin: "https://identity.example",
    now: () => now,
    fetch: async () => Response.json({ excessive: "x".repeat(33 * 1024) }),
  });
  await assert.rejects(
    authority.verify(token(), signal()),
    /pim_account_response_invalid/,
  );
});

test("explicit directory cache is bounded, expires and never retains failed or expired account validation", async () => {
  let clock = now;
  let active = true;
  let calls = 0;
  const authority = new PimAccountAuthority({
    origin: "http://127.0.0.1:8000",
    now: () => clock,
    cacheTtlMs: 150,
    fetch: async (url) => {
      calls++;
      return Response.json(
        new URL(String(url)).pathname.endsWith("/me")
          ? {
              id: 12,
              is_active: active,
              approval_status: "approved",
              role: "user",
            }
          : { access_token: token() },
      );
    },
  });
  await authority.verify(token(), signal());
  await authority.verify(token(), signal());
  assert.equal(calls, 2);
  active = false;
  clock += 150;
  await assert.rejects(
    authority.verify(token(), signal()),
    /inactive_or_changed/u,
  );
  await assert.rejects(
    authority.verify(token(), signal()),
    /inactive_or_changed/u,
  );
  assert.equal(calls, 4);
  active = true;
  await authority.verify(token(), signal());
  await assert.rejects(
    authority.verify(token({ exp: clock / 1000 - 1 }), signal()),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(authority.verify(token(), aborted.signal));
  for (const cacheTtlMs of [-1, 251, Infinity])
    assert.throws(
      () =>
        new PimAccountAuthority({
          origin: "http://127.0.0.1:8000",
          cacheTtlMs,
        }),
      /cache_invalid/u,
    );
});
