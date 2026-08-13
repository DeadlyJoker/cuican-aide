import type { ArtifactView } from "@crewon/contracts/runtime";
import type { ArtifactRecord } from "@crewon/domain";

export function projectArtifact(artifact: ArtifactRecord): ArtifactView {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    sensitivity: artifact.sensitivity,
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
    source: {
      kind: artifact.source.kind,
      runId: artifact.source.runId,
      stepId: artifact.source.stepId,
      callId: artifact.source.callId,
    },
    retention: structuredClone(artifact.retention),
    encryption: { scheme: artifact.encryption.scheme },
    scan: {
      status: artifact.scan.status,
      scannedAt: artifact.scan.scannedAt,
    },
    createdAt: artifact.createdAt,
  };
}
