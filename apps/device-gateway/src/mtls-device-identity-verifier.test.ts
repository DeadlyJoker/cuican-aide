import assert from "node:assert/strict";
import { type IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { TLSSocket, type DetailedPeerCertificate } from "node:tls";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import { parseDeviceRegistryConfig } from "./device-registry-config.ts";
import { MtlsDeviceIdentityVerifier } from "./mtls-device-identity-verifier.ts";
import { MtlsGatewayIdentityVerifier } from "./mtls-gateway-identity-verifier.ts";
import { MtlsWorkerIdentityVerifier } from "./mtls-worker-identity-verifier.ts";

const fingerprint = Array.from({ length: 32 }, () => "AA").join(":");
const workerFingerprint = Array.from({ length: 32 }, () => "BB").join(":");
const gatewayFingerprint = Array.from({ length: 32 }, () => "CC").join(":");
const now = () => new Date("2026-08-08T00:00:00.000Z");

test("maps an authorized, valid registered mTLS certificate to an opaque Device identity", async () => {
  const verifier = new MtlsDeviceIdentityVerifier([registration()], { now });
  const identity = await verifier.verify(
    requestWithCertificate({
      authorized: true,
      fingerprint256: fingerprint,
      validFrom: "Aug  7 00:00:00 2026 GMT",
      validTo: "Aug  9 00:00:00 2026 GMT",
    }),
  );

  assert.deepEqual(identity, {
    deviceId: "device-1",
    credentialId: "credential-1",
    authenticationMethod: "mtls",
    authenticatedAt: "2026-08-08T00:00:00.000Z",
  });
});

test("rejects unauthorized, expired and unregistered peer certificates", async () => {
  const verifier = new MtlsDeviceIdentityVerifier([registration()], { now });
  for (const [request, code] of [
    [
      requestWithCertificate({
        authorized: false,
        fingerprint256: fingerprint,
        validFrom: "Aug  7 00:00:00 2026 GMT",
        validTo: "Aug  9 00:00:00 2026 GMT",
      }),
      "device_mtls_unauthorized",
    ],
    [
      requestWithCertificate({
        authorized: true,
        fingerprint256: fingerprint,
        validFrom: "Aug  5 00:00:00 2026 GMT",
        validTo: "Aug  6 00:00:00 2026 GMT",
      }),
      "device_peer_certificate_expired",
    ],
    [
      requestWithCertificate({
        authorized: true,
        fingerprint256: Array.from({ length: 32 }, () => "BB").join(":"),
        validFrom: "Aug  7 00:00:00 2026 GMT",
        validTo: "Aug  9 00:00:00 2026 GMT",
      }),
      "device_certificate_unregistered",
    ],
  ] as const) {
    await assert.rejects(verifier.verify(request), hasCode(code));
  }
});

test("parses a strict unique Device certificate registry", () => {
  const config = {
    schemaVersion: "crewon.device-registry.v0",
    devices: [registration()],
    workers: [workerRegistration()],
    commandSigningKeys: [
      {
        keyId: "control-key-1",
        publicKeyPem: "fixture-public-key",
      },
    ],
  } as const;
  assert.deepEqual(parseDeviceRegistryConfig(config), {
    ...config,
    gateways: [],
  });
  assert.deepEqual(
    parseDeviceRegistryConfig({
      ...config,
      gateways: [gatewayRegistration()],
    }).gateways,
    [gatewayRegistration()],
  );
  assert.throws(
    () =>
      parseDeviceRegistryConfig({
        ...config,
        devices: [registration(), registration()],
      }),
    hasCode("device_registration_invalid"),
  );
  assert.throws(
    () => parseDeviceRegistryConfig({ ...config, trustedHeader: "x-device" }),
    hasCode("device_registry_fields_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceRegistryConfig({
        ...config,
        gateways: [{ ...gatewayRegistration(), fingerprint256: fingerprint }],
      }),
    hasCode("gateway_registration_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceRegistryConfig({
        ...config,
        gateways: [
          { ...gatewayRegistration(), endpoint: "http://gateway-1.internal" },
        ],
      }),
    hasCode("gateway_registration_invalid"),
  );
});

test("maps only a registered Gateway certificate to peer authority", async () => {
  const verifier = new MtlsGatewayIdentityVerifier([gatewayRegistration()], {
    now,
  });
  assert.deepEqual(
    await verifier.verify(
      requestWithCertificate({
        authorized: true,
        fingerprint256: gatewayFingerprint,
        validFrom: "Aug  7 00:00:00 2026 GMT",
        validTo: "Aug  9 00:00:00 2026 GMT",
      }),
    ),
    {
      gatewayId: "gateway-1",
      credentialId: "gateway-credential-1",
      authenticationMethod: "mtls",
      authenticatedAt: "2026-08-08T00:00:00.000Z",
    },
  );
  await assert.rejects(
    verifier.verify(
      requestWithCertificate({
        authorized: true,
        fingerprint256: workerFingerprint,
        validFrom: "Aug  7 00:00:00 2026 GMT",
        validTo: "Aug  9 00:00:00 2026 GMT",
      }),
    ),
    hasCode("gateway_certificate_unregistered"),
  );
});

test("maps only a registered Worker certificate to Worker authority", async () => {
  const verifier = new MtlsWorkerIdentityVerifier([workerRegistration()], {
    now,
  });
  assert.deepEqual(
    await verifier.verify(
      requestWithCertificate({
        authorized: true,
        fingerprint256: workerFingerprint,
        validFrom: "Aug  7 00:00:00 2026 GMT",
        validTo: "Aug  9 00:00:00 2026 GMT",
      }),
    ),
    {
      workerId: "worker-1",
      credentialId: "worker-credential-1",
      authenticationMethod: "mtls",
      authenticatedAt: "2026-08-08T00:00:00.000Z",
    },
  );
  await assert.rejects(
    verifier.verify(
      requestWithCertificate({
        authorized: true,
        fingerprint256: fingerprint,
        validFrom: "Aug  7 00:00:00 2026 GMT",
        validTo: "Aug  9 00:00:00 2026 GMT",
      }),
    ),
    hasCode("worker_certificate_unregistered"),
  );
});

function registration() {
  return {
    deviceId: "device-1",
    credentialId: "credential-1",
    fingerprint256: fingerprint,
  } as const;
}

function workerRegistration() {
  return {
    workerId: "worker-1",
    credentialId: "worker-credential-1",
    fingerprint256: workerFingerprint,
  } as const;
}

function gatewayRegistration() {
  return {
    gatewayId: "gateway-1",
    credentialId: "gateway-credential-1",
    fingerprint256: gatewayFingerprint,
    endpoint: "https://gateway-1.internal:8443",
  } as const;
}

function requestWithCertificate(config: {
  authorized: boolean;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
}): IncomingMessage {
  const socket = new TLSSocket(new Socket());
  Object.defineProperty(socket, "authorized", { value: config.authorized });
  Object.defineProperty(socket, "getPeerCertificate", {
    value: () =>
      ({
        fingerprint256: config.fingerprint256,
        valid_from: config.validFrom,
        valid_to: config.validTo,
      }) as DetailedPeerCertificate,
  });
  return { socket } as unknown as IncomingMessage;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DeviceGatewayError && error.code === code;
}
