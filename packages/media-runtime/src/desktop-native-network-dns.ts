import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  NetworkDnsResolver,
  NetworkResolvedAddress,
} from "./network-egress.ts";
import { SystemProviderProbeDnsResolver } from "./provider-probe-egress.ts";

const MAX_ADDRESSES = 16;
const QUERY_TIMEOUT_MS = 3_000;

/** Trusted Native composition captures these from its installed authority. */
export type DesktopNativeNetworkDnsAuthority = Readonly<{
  hostnames: readonly string[];
  assertCurrent(): void;
}>;

/** Per-resolution ports for host tests; never supplied by plugin configuration. */
export type DesktopNativeNetworkDnsDependencies = Readonly<{
  system?: NetworkDnsResolver;
  createPublicResolver?: () => Readonly<{
    resolve4(hostname: string): Promise<readonly string[]>;
    resolve6(hostname: string): Promise<readonly string[]>;
    cancel(): void;
  }>;
}>;

/**
 * Ordinary system answers retain the production egress policy. An exact Native
 * grant may replace an entirely Fake-IP answer with fresh public DNS answers;
 * those answers still require the original egress policy and pinned TLS socket.
 */
export function createDesktopNativeNetworkDnsResolver(
  authority: DesktopNativeNetworkDnsAuthority,
  dependencies: DesktopNativeNetworkDnsDependencies = {},
): NetworkDnsResolver {
  const hostnames = new Set(authority.hostnames.map(captureHostname));
  const assertCurrent = authority.assertCurrent.bind(authority);
  const system = dependencies.system ?? new SystemProviderProbeDnsResolver();
  const resolveSystem = system.resolveAll.bind(system);
  const createPublicResolver =
    dependencies.createPublicResolver ?? nativePublicResolver;

  return Object.freeze({
    async resolveAll(
      hostname: string,
    ): Promise<readonly NetworkResolvedAddress[]> {
      assertCurrent();
      let original: readonly NetworkResolvedAddress[];
      try {
        original = captureAddresses(
          await bounded(Promise.resolve(resolveSystem(hostname))),
        );
      } finally {
        assertCurrent();
      }
      if (
        !hostnames.has(hostname) ||
        isIP(hostname.replace(/^\[|\]$/gu, "")) !== 0 ||
        !original.every(isFakeIp)
      ) {
        return original;
      }

      assertCurrent();
      let resolver: ReturnType<typeof createPublicResolver> | undefined;
      try {
        resolver = createPublicResolver();
        const [ipv4, ipv6] = await bounded(
          Promise.allSettled([
            resolver.resolve4(hostname),
            resolver.resolve6(hostname),
          ]),
        );
        return captureAddresses([
          ...familyAnswers(ipv4, 4),
          ...familyAnswers(ipv6, 6),
        ]);
      } finally {
        try {
          resolver?.cancel();
        } finally {
          assertCurrent();
        }
      }
    },
  });
}

function nativePublicResolver() {
  // Per-instance configuration never changes the system/global DNS resolver.
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers(["8.8.8.8"]);
  return resolver;
}

function captureHostname(hostname: string): string {
  if (
    typeof hostname !== "string" ||
    hostname.length === 0 ||
    hostname.length > 253 ||
    /[\s/?#@*\\]/u.test(hostname)
  ) {
    throw new Error("desktop_native_dns_hostname_invalid");
  }
  try {
    if (new URL(`https://${hostname}/`).hostname === hostname) return hostname;
  } catch {
    // A malformed host can never become a fallback grant.
  }
  throw new Error("desktop_native_dns_hostname_invalid");
}

function captureAddresses(
  input: readonly NetworkResolvedAddress[],
): readonly NetworkResolvedAddress[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_ADDRESSES
  )
    throw new Error("desktop_native_dns_answers_invalid");
  const seen = new Set<string>();
  return Object.freeze(
    input.map(({ address, family }) => {
      if (
        typeof address !== "string" ||
        (family !== 4 && family !== 6) ||
        isIP(address) !== family ||
        seen.has(address)
      ) {
        throw new Error("desktop_native_dns_answers_invalid");
      }
      seen.add(address);
      return Object.freeze({ address, family });
    }),
  );
}

function isFakeIp({ address, family }: NetworkResolvedAddress): boolean {
  return family === 4 && /^198\.(?:18|19)\./u.test(address);
}

function familyAnswers(
  result: PromiseSettledResult<readonly string[]>,
  family: 4 | 6,
): readonly NetworkResolvedAddress[] {
  if (result.status === "rejected") {
    // A timeout in one independent family does not invalidate a fresh answer
    // in the other. captureAddresses still requires a nonempty result, and the
    // complete returned set still passes the production policy and pinned TLS.
    // Authoritative failures and cancellation remain failures.
    if (
      typeof result.reason === "object" &&
      result.reason !== null &&
      "code" in result.reason &&
      (result.reason.code === "ENODATA" || result.reason.code === "ETIMEOUT")
    ) {
      return [];
    }
    throw result.reason;
  }
  if (!Array.isArray(result.value) || result.value.length > MAX_ADDRESSES)
    throw new Error("desktop_native_dns_answers_invalid");
  return result.value.map((address) => ({ address, family }));
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("desktop_native_dns_timeout")),
          QUERY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
