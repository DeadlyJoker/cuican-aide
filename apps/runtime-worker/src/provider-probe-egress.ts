import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_DNS_ADDRESSES = 16;

export type ProviderProbeResolvedAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type ProviderProbeEgressInput = Readonly<{
  tenantId: string;
  providerId: string;
  endpoint: URL;
  addresses: readonly ProviderProbeResolvedAddress[];
}>;

export type ProviderProbeEgressDecision = Readonly<{
  approvedAddresses: readonly string[];
}>;

/** Tenant policy must approve every resolved address before one is socket-pinned. */
export interface ProviderProbeEgressPolicy {
  authorize(
    input: ProviderProbeEgressInput,
  ): ProviderProbeEgressDecision | Promise<ProviderProbeEgressDecision>;
}

export interface ProviderProbeDnsResolver {
  resolveAll(hostname: string): Promise<readonly ProviderProbeResolvedAddress[]>;
}

export type PinnedProviderProbeEndpoint = Readonly<{
  endpoint: URL;
  address: string;
  family: 4 | 6;
}>;

export class SystemProviderProbeDnsResolver implements ProviderProbeDnsResolver {
  async resolveAll(
    hostname: string,
  ): Promise<readonly ProviderProbeResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    }));
  }
}

/** Standalone desktop policy: public HTTPS or explicit loopback HTTP/HTTPS. */
export class DesktopProviderProbeEgressPolicy
  implements ProviderProbeEgressPolicy
{
  authorize(input: ProviderProbeEgressInput): ProviderProbeEgressDecision {
    const loopbackEndpoint =
      loopbackHostname(input.endpoint.hostname) &&
      input.addresses.every(
        ({ address }) => providerAddressKind(address) === "loopback",
      );
    const publicHttps =
      input.endpoint.protocol === "https:" &&
      input.addresses.every(
        ({ address }) => providerAddressKind(address) === "public",
      );
    if (
      !publicHttps &&
      !(
        loopbackEndpoint &&
        (input.endpoint.protocol === "http:" ||
          input.endpoint.protocol === "https:")
      )
    ) {
      throw new ProviderProbeEgressError("provider_probe_egress_denied");
    }
    return {
      approvedAddresses: input.addresses.map(({ address }) => address),
    };
  }
}

/** Resolves once, validates every answer, then returns one approved pinned address. */
export class ProviderProbeEgressResolver {
  readonly #dns: ProviderProbeDnsResolver;
  readonly #policy: ProviderProbeEgressPolicy;

  constructor(dependencies: {
    dns?: ProviderProbeDnsResolver;
    policy: ProviderProbeEgressPolicy;
  }) {
    this.#dns = dependencies.dns ?? new SystemProviderProbeDnsResolver();
    this.#policy = dependencies.policy;
  }

  async resolve(
    input: Readonly<{
      tenantId: string;
      providerId: string;
      endpoint: URL;
    }>,
    signal: AbortSignal,
  ): Promise<PinnedProviderProbeEndpoint> {
    const addresses = validateDnsAddresses(
      await abortable(this.#dns.resolveAll(input.endpoint.hostname), signal),
    );
    if (addresses.some(({ address }) => intrinsicallyUnsafe(address))) {
      throw new ProviderProbeEgressError("provider_probe_egress_denied");
    }
    const decision = await abortable(
      Promise.resolve(
        this.#policy.authorize({
          ...input,
          addresses,
        }),
      ),
      signal,
    );
    const approved = validateDecision(decision, addresses);
    const selected = addresses.find(({ address }) => approved.has(address));
    if (selected === undefined) {
      throw new ProviderProbeEgressError("provider_probe_egress_denied");
    }
    return {
      endpoint: new URL(input.endpoint),
      address: selected.address,
      family: selected.family,
    };
  }
}

export class ProviderProbeEgressError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ProviderProbeEgressError";
    this.code = code;
  }
}

export type ProviderAddressKind =
  | "public"
  | "private"
  | "loopback"
  | "linkLocal"
  | "metadata"
  | "transition"
  | "mapped"
  | "unspecified"
  | "multicast"
  | "invalid";

export function providerAddressKind(address: string): ProviderAddressKind {
  const family = isIP(address);
  if (family === 4) return ipv4Kind(ipv4Bytes(address));
  if (family !== 6) return "invalid";
  const bytes = ipv6Bytes(address);
  if (bytes === null) return "invalid";
  if (bytes.every((value) => value === 0)) return "unspecified";
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) {
    return "loopback";
  }
  if (
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return "mapped";
  }
  if (bytes[0] === 0xff) return "multicast";
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return "linkLocal";
  if ((bytes[0]! & 0xfe) === 0xfc) return "private";
  if (
    matchesPrefix(
      bytes,
      [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0],
      96,
    )
  ) {
    return "transition";
  }
  if (matchesPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) {
    return "transition";
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return "transition";
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return "transition";
  }
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return "private";
  }
  if (matchesPrefix(bytes, [0x20, 0x01, 0x00], 23)) return "private";
  if (matchesPrefix(bytes, [0x3f, 0xff, 0x00], 20)) return "private";
  return (bytes[0]! & 0xe0) === 0x20 ? "public" : "private";
}

function validateDnsAddresses(
  value: readonly ProviderProbeResolvedAddress[],
): readonly ProviderProbeResolvedAddress[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_DNS_ADDRESSES
  ) {
    throw new ProviderProbeEgressError("provider_probe_dns_invalid");
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      (candidate.family !== 4 && candidate.family !== 6) ||
      isIP(candidate.address) !== candidate.family ||
      seen.has(candidate.address)
    ) {
      throw new ProviderProbeEgressError("provider_probe_dns_invalid");
    }
    seen.add(candidate.address);
    return { address: candidate.address, family: candidate.family };
  });
}

function validateDecision(
  decision: ProviderProbeEgressDecision,
  resolved: readonly ProviderProbeResolvedAddress[],
): ReadonlySet<string> {
  if (
    decision === null ||
    typeof decision !== "object" ||
    !Array.isArray(decision.approvedAddresses) ||
    decision.approvedAddresses.length !== resolved.length
  ) {
    throw new ProviderProbeEgressError("provider_probe_egress_decision_invalid");
  }
  const approved = new Set(decision.approvedAddresses);
  if (
    approved.size !== resolved.length ||
    resolved.some(({ address }) => !approved.has(address))
  ) {
    throw new ProviderProbeEgressError("provider_probe_egress_decision_invalid");
  }
  return approved;
}

function intrinsicallyUnsafe(address: string): boolean {
  const kind = providerAddressKind(address);
  return (
    kind === "invalid" ||
    kind === "metadata" ||
    kind === "mapped" ||
    kind === "transition" ||
    kind === "unspecified" ||
    kind === "multicast" ||
    kind === "linkLocal"
  );
}

function ipv4Kind(bytes: readonly number[]): ProviderAddressKind {
  const [a, b] = bytes;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) {
    return bytes[2] === 169 && bytes[3] === 254 ? "metadata" : "linkLocal";
  }
  if (
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && bytes[2] === 99) ||
    (a === 192 && b === 0 && bytes[2] === 2) ||
    (a === 198 && b === 51 && bytes[2] === 100) ||
    (a === 203 && b === 0 && bytes[2] === 113) ||
    a === 255
  ) {
    return "private";
  }
  if (a! >= 224) return "multicast";
  return "public";
}

function ipv4Bytes(address: string): readonly number[] {
  return address.split(".").map(Number);
}

function ipv6Bytes(address: string): readonly number[] | null {
  const zoneIndex = address.indexOf("%");
  const input = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = hextets(halves[0] ?? "");
  const right = hextets(halves[1] ?? "");
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const values = [...left, ...Array<number>(missing).fill(0), ...right];
  if (values.length !== 8) return null;
  return values.flatMap((value) => [value >>> 8, value & 0xff]);
}

function hextets(value: string): readonly number[] | null {
  if (value === "") return [];
  const parts = value.split(":");
  const values: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.includes(".")) {
      if (index !== parts.length - 1 || isIP(part) !== 4) return null;
      const bytes = ipv4Bytes(part);
      values.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
    } else {
      if (!/^[0-9a-f]{1,4}$/iu.test(part)) return null;
      values.push(Number.parseInt(part, 16));
    }
  }
  return values;
}

function matchesPrefix(
  bytes: readonly number[],
  expected: readonly number[],
  bits: number,
): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;
  if (expected.length !== Math.ceil(bits / 8)) return false;
  if (
    !expected
      .slice(0, fullBytes)
      .every((value, index) => bytes[index] === value)
  ) {
    return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[fullBytes]! & mask) === (expected[fullBytes]! & mask);
}

function loopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    (isIP(value) === 4 && providerAddressKind(value) === "loopback")
  );
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
