import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopNativeNetworkDnsResolver,
  type DesktopNativeNetworkDnsDependencies,
} from "./desktop-native-network-dns.ts";
import {
  NetworkEgressError,
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
  type NetworkResolvedAddress,
} from "./network-egress.ts";

const host = "media.example.com";
const fake: readonly NetworkResolvedAddress[] = [
  { address: "198.18.12.7", family: 4 },
  { address: "198.19.255.254", family: 4 },
];
const public4 = { address: "8.8.4.4", family: 4 } as const;
const public6 = { address: "2001:4860:4860::8888", family: 6 } as const;
const private4 = { address: "10.0.0.2", family: 4 } as const;
const noData = Object.assign(new Error("record_family_absent"), {
  code: "ENODATA",
});

function fixture(
  system: () => Promise<readonly NetworkResolvedAddress[]>,
  options: Readonly<{
    ipv4?: readonly string[] | Error;
    ipv6?: readonly string[] | Error;
    assertCurrent?: () => void;
    hostnames?: readonly string[];
    publicResolver?: DesktopNativeNetworkDnsDependencies["createPublicResolver"];
  }> = {},
) {
  const calls = {
    system: 0,
    create: 0,
    ipv4: 0,
    ipv6: 0,
    cancel: 0,
    current: 0,
  };
  const dns = createDesktopNativeNetworkDnsResolver(
    {
      hostnames: options.hostnames ?? [host],
      assertCurrent() {
        calls.current++;
        options.assertCurrent?.();
      },
    },
    {
      system: {
        resolveAll: async () => {
          calls.system++;
          return system();
        },
      },
      createPublicResolver: () => {
        calls.create++;
        return (
          options.publicResolver?.() ?? {
            async resolve4(requestHost) {
              calls.ipv4++;
              assert.equal(requestHost, host);
              if (options.ipv4 instanceof Error) throw options.ipv4;
              return options.ipv4 ?? [public4.address];
            },
            async resolve6(requestHost) {
              calls.ipv6++;
              assert.equal(requestHost, host);
              if (options.ipv6 instanceof Error) throw options.ipv6;
              return options.ipv6 ?? [public6.address];
            },
            cancel() {
              calls.cancel++;
            },
          }
        );
      },
    },
  );
  return { dns, calls };
}

test("only an exact captured grant with entirely Fake-IP answers resolves both families afresh", async () => {
  const names = [host];
  const { dns, calls } = fixture(async () => fake, { hostnames: names });
  names.length = 0;
  const actual = await dns.resolveAll(host);
  assert.deepEqual(actual, [public4, public6]);
  assert.ok(Object.isFrozen(dns));
  assert.ok(Object.isFrozen(actual));
  assert.ok(actual.every(Object.isFrozen));
  assert.deepEqual(calls, {
    system: 1,
    create: 1,
    ipv4: 1,
    ipv6: 1,
    cancel: 1,
    current: 4,
  });
  await dns.resolveAll(host);
  assert.equal(calls.create, 2);
  assert.equal(calls.cancel, 2);
});

test("normal public, private and mixed system answers never use fallback", async () => {
  for (const addresses of [
    [public4, public6],
    [private4],
    [public4, fake[0]],
    [private4, fake[0]],
    [{ address: "198.17.12.7", family: 4 } as const],
    [{ address: "198.20.12.7", family: 4 } as const],
  ]) {
    const { dns, calls } = fixture(async () => addresses);
    assert.deepEqual(await dns.resolveAll(host), addresses);
    assert.equal(calls.create, 0);
    assert.equal(calls.current, 2);
  }
});

test("prefixes, suffixes, case changes, IP literals and absent grants cannot use fallback", async () => {
  for (const hostname of [
    `prefix.${host}`,
    `${host}.attacker.example`,
    host.toUpperCase(),
    "198.18.12.7",
    "[::1]",
  ]) {
    const { dns, calls } = fixture(async () => fake, {
      hostnames: [host, "198.18.12.7", "[::1]"],
    });
    assert.deepEqual(await dns.resolveAll(hostname), fake);
    assert.equal(calls.create, 0);
  }
  const { dns, calls } = fixture(async () => fake, { hostnames: [] });
  assert.deepEqual(await dns.resolveAll(host), fake);
  assert.equal(calls.create, 0);
});

test("system errors and malformed answers fail closed without a public query", async () => {
  const fault = new Error("system_dns_failed");
  const failing = fixture(async () => {
    throw fault;
  });
  await assert.rejects(
    failing.dns.resolveAll(host),
    (error) => error === fault,
  );
  assert.equal(failing.calls.create, 0);
  assert.equal(failing.calls.current, 2);
  for (const answers of [
    [],
    [{ address: "not-an-ip", family: 4 }],
    [{ address: "198.18.12.7", family: 6 }],
    [fake[0], fake[0]],
    Array.from({ length: 17 }, (_, i) => ({
      address: `198.18.12.${i}`,
      family: 4,
    })),
  ]) {
    const { dns, calls } = fixture(
      async () => answers as readonly NetworkResolvedAddress[],
    );
    await assert.rejects(
      dns.resolveAll(host),
      /desktop_native_dns_answers_invalid/,
    );
    assert.equal(calls.create, 0);
  }
});

test("an absent or timed out family permits only fresh answers from the other family", async () => {
  const ipv4Only = fixture(async () => fake, { ipv6: noData });
  assert.deepEqual(await ipv4Only.dns.resolveAll(host), [public4]);
  const ipv6Only = fixture(async () => fake, { ipv4: noData });
  assert.deepEqual(await ipv6Only.dns.resolveAll(host), [public6]);
  const timeout = Object.assign(new Error("queryAaaa ETIMEOUT"), {
    code: "ETIMEOUT",
  });
  for (const options of [{ ipv6: timeout }, { ipv4: timeout }]) {
    const { dns, calls } = fixture(async () => fake, options);
    assert.deepEqual(await dns.resolveAll(host), [
      options.ipv6 ? public4 : public6,
    ]);
    assert.equal(calls.cancel, 1);
    assert.equal(calls.current, 4);
  }
});

test("authoritative failures, cancellation and malformed public answers are denied", async () => {
  for (const code of ["ESERVFAIL", "ENOTFOUND", "ECANCELLED"]) {
    const fault = Object.assign(new Error(code), { code });
    const { dns, calls } = fixture(async () => fake, { ipv6: fault });
    await assert.rejects(dns.resolveAll(host), (error) => error === fault);
    assert.equal(calls.create, 1);
    assert.equal(calls.cancel, 1);
    assert.equal(calls.current, 4);
  }
  for (const options of [
    { ipv4: noData, ipv6: noData },
    {
      ipv4: Object.assign(new Error("timeout"), { code: "ETIMEOUT" }),
      ipv6: noData,
    },
    {
      ipv4: Object.assign(new Error("timeout"), { code: "ETIMEOUT" }),
      ipv6: Object.assign(new Error("timeout"), { code: "ETIMEOUT" }),
    },
    { ipv4: [], ipv6: [] },
    { ipv4: ["198.18.12.7", "198.18.12.7"], ipv6: noData },
    { ipv4: [public6.address], ipv6: noData },
    { ipv4: ["not-an-ip"], ipv6: noData },
  ]) {
    const { dns, calls } = fixture(async () => fake, options);
    await assert.rejects(
      dns.resolveAll(host),
      /desktop_native_dns_answers_invalid/,
    );
    assert.equal(calls.cancel, 1);
  }
});

test("fallback answers including a single timed out family retain the unchanged production policy", async () => {
  for (const ipv4 of [
    [private4.address],
    [public4.address, private4.address],
    [fake[0].address],
  ]) {
    const { dns } = fixture(async () => fake, {
      ipv4,
      ipv6: Object.assign(new Error("timeout"), { code: "ETIMEOUT" }),
    });
    assert.equal((await dns.resolveAll(host)).length, ipv4.length);
    const resolver = new NetworkEgressResolver({
      dns,
      policy: new ProductionNetworkEgressPolicy(),
    });
    await assert.rejects(
      resolver.resolve(
        {
          tenantId: "test-native-dns",
          scopeId: "test-policy-preservation",
          endpoint: new URL(`https://${host}/system_stats`),
        },
        AbortSignal.timeout(1_000),
      ),
      (error) =>
        error instanceof NetworkEgressError &&
        error.code === "network_egress_denied",
    );
  }
});

test("authority withdrawal before or during system resolution prevents fallback", async () => {
  let live = false;
  const assertCurrent = () => {
    if (!live) throw new Error("native_authority_withdrawn");
  };
  const before = fixture(async () => fake, { assertCurrent });
  await assert.rejects(
    before.dns.resolveAll(host),
    /native_authority_withdrawn/,
  );
  assert.equal(before.calls.system, 0);
  live = true;
  const during = fixture(
    async () => {
      live = false;
      return fake;
    },
    { assertCurrent },
  );
  await assert.rejects(
    during.dns.resolveAll(host),
    /native_authority_withdrawn/,
  );
  assert.equal(during.calls.create, 0);
});

test("withdrawal during public resolution cancels it and never returns its addresses", async () => {
  let live = true;
  let cancelled = 0;
  const { dns, calls } = fixture(async () => fake, {
    assertCurrent() {
      if (!live) throw new Error("native_authority_withdrawn");
    },
    publicResolver: () => ({
      async resolve4() {
        live = false;
        return [public4.address];
      },
      async resolve6() {
        return [public6.address];
      },
      cancel() {
        cancelled++;
      },
    }),
  });
  await assert.rejects(dns.resolveAll(host), /native_authority_withdrawn/);
  assert.equal(cancelled, 1);
  assert.equal(calls.current, 4);
});

test("a stalled public query has a hard deadline, cancels and rechecks authority", async () => {
  let cancelled = 0;
  const { dns, calls } = fixture(async () => fake, {
    publicResolver: () => ({
      resolve4: () => new Promise(() => {}),
      async resolve6() {
        return [public6.address];
      },
      cancel() {
        cancelled++;
      },
    }),
  });
  await assert.rejects(dns.resolveAll(host), /desktop_native_dns_timeout/);
  assert.equal(cancelled, 1);
  assert.equal(calls.current, 4);
});

test("malformed wildcard or URL grants cannot construct a fallback authority", () => {
  for (const hostname of [
    "",
    "*.example.com",
    "https://media.example.com",
    `${host}:8443`,
    `${host}/path`,
    `${host}?query`,
    `${host}#fragment`,
    `${host}@attacker.example`,
    "MEDIA.example.com",
  ]) {
    assert.throws(
      () =>
        createDesktopNativeNetworkDnsResolver({
          hostnames: [hostname],
          assertCurrent() {},
        }),
      /desktop_native_dns_hostname_invalid/,
    );
  }
});
