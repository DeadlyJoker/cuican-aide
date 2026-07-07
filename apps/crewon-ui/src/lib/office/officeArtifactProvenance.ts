import type { ArtifactItem } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

const CONTENT_STATUS_LABELS_EN: Record<string, string> = {
  fingerprinted: "verified",
  missing: "missing",
  notFile: "not a file",
  outsideWorkspace: "outside workspace",
  tooLarge: "too large",
  unreadable: "unreadable",
};

const CONTENT_STATUS_LABELS_ZH: Record<string, string> = {
  fingerprinted: "已验证",
  missing: "缺失",
  notFile: "非文件",
  outsideWorkspace: "工作区外",
  tooLarge: "过大",
  unreadable: "不可读",
};

function artifactContentSourceLabel(
  source: ArtifactItem["contentSource"],
  locale: Locale,
) {
  if (source === "file") {
    return locale === "zh" ? "文件" : "file";
  }
  if (source === "inline") {
    return locale === "zh" ? "内联" : "inline";
  }
  return source;
}

export function artifactContentStatusLabel(
  artifact: ArtifactItem,
  locale: Locale,
) {
  const status = artifact.contentStatus;
  if (!status) {
    return null;
  }

  const statusLabel =
    locale === "zh"
      ? CONTENT_STATUS_LABELS_ZH[status] ?? status
      : CONTENT_STATUS_LABELS_EN[status] ?? status;
  const sourceLabel = artifactContentSourceLabel(artifact.contentSource, locale);
  if (!sourceLabel) {
    return statusLabel;
  }
  return locale === "zh"
    ? `${sourceLabel}${statusLabel}`
    : `${sourceLabel} ${statusLabel}`;
}

export function artifactContentErrorLabel(error: string) {
  if (error.length <= 96) {
    return error;
  }
  return `${error.slice(0, 93)}...`;
}

export function artifactActivityMeta(artifact: ArtifactItem, locale: Locale) {
  const details = [artifact.meta].filter(Boolean);
  const contentStatus = artifactContentStatusLabel(artifact, locale);
  if (contentStatus) {
    details.push(contentStatus);
  }
  if (artifact.contentError) {
    details.push(artifactContentErrorLabel(artifact.contentError));
  }
  if (artifact.contentSha256) {
    details.push(`sha ${artifact.contentSha256.slice(0, 12)}`);
  }
  if (typeof artifact.contentBytes === "number") {
    details.push(
      locale === "zh"
        ? `${artifact.contentBytes} 字节`
        : `${artifact.contentBytes} bytes`,
    );
  }
  if (artifact.path) {
    details.push(artifact.path);
  } else if (artifact.url) {
    details.push(artifact.url);
  }
  if (artifact.member) {
    details.push(
      artifact.agentId ? `${artifact.member}/${artifact.agentId}` : artifact.member,
    );
  }
  if (artifact.delegationId) {
    details.push(artifact.delegationId);
  }
  if (artifact.sourceTurnId) {
    details.push(
      locale === "zh"
        ? `回合 ${artifact.sourceTurnId}`
        : `turn ${artifact.sourceTurnId}`,
    );
  }
  return details.join(" · ");
}

export function artifactRecordText(
  artifact: ArtifactItem,
  locale: Locale,
  currentContentSha256?: string | null,
) {
  const contentStatus = artifactContentStatusLabel(artifact, locale);
  const producer = artifact.member
    ? artifact.agentId
      ? `${artifact.member}/${artifact.agentId}`
      : artifact.member
    : null;
  const labels =
    locale === "zh"
      ? {
          bytes: "字节",
          content: "内容",
          currentSha: "当前读取 SHA-256",
          delegation: "委派",
          error: "错误",
          fingerprint: "指纹",
          fingerprintDiffers: "不同于后端记录",
          fingerprintMatches: "匹配后端记录",
          observed: "观察时间",
          path: "路径",
          producer: "生产者",
          record: "后端内容记录：",
          thread: "线程",
          turn: "回合",
          url: "URL",
        }
      : {
          bytes: "Bytes",
          content: "Content",
          currentSha: "Current read SHA-256",
          delegation: "Delegation",
          error: "Error",
          fingerprint: "Fingerprint",
          fingerprintDiffers: "differs from backend record",
          fingerprintMatches: "matches backend record",
          observed: "Observed",
          path: "Path",
          producer: "Producer",
          record: "Backend content record:",
          thread: "Thread",
          turn: "Turn",
          url: "URL",
        };

  const rows = [
    contentStatus ? `${labels.content}: ${contentStatus}` : null,
    artifact.contentSha256 ? `SHA-256: ${artifact.contentSha256}` : null,
    currentContentSha256
      ? `${labels.currentSha}: ${currentContentSha256}`
      : null,
    artifact.contentSha256 && currentContentSha256
      ? `${labels.fingerprint}: ${
          artifact.contentSha256.toLowerCase() ===
          currentContentSha256.toLowerCase()
            ? labels.fingerprintMatches
            : labels.fingerprintDiffers
        }`
      : null,
    typeof artifact.contentBytes === "number"
      ? `${labels.bytes}: ${artifact.contentBytes}`
      : null,
    artifact.contentObservedAt
      ? `${labels.observed}: ${artifact.contentObservedAt}`
      : null,
    artifact.path ? `${labels.path}: ${artifact.path}` : null,
    artifact.url ? `${labels.url}: ${artifact.url}` : null,
    producer ? `${labels.producer}: ${producer}` : null,
    artifact.delegationId
      ? `${labels.delegation}: ${artifact.delegationId}`
      : null,
    artifact.sourceThreadId ? `${labels.thread}: ${artifact.sourceThreadId}` : null,
    artifact.sourceTurnId ? `${labels.turn}: ${artifact.sourceTurnId}` : null,
    artifact.contentError
      ? `${labels.error}: ${artifactContentErrorLabel(artifact.contentError)}`
      : null,
  ].filter((row): row is string => Boolean(row));

  if (rows.length === 0) {
    return "";
  }
  return [labels.record, ...rows.map((row) => `- ${row}`)].join("\n");
}
