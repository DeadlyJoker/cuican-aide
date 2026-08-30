use std::fmt;

use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

const WORKSPACE_KEY_PREFIX: &str = "workspace:";
const MAX_ID_BYTES: usize = 255;
const DIGEST_PREFIX: &str = "sha256:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableWorkspaceRootRecordErrorKind {
    Empty,
    TooLong,
    InvalidWorkspaceKey,
    InvalidDigest,
    OutOfRange,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableWorkspaceRootRecordError {
    field: &'static str,
    kind: DurableWorkspaceRootRecordErrorKind,
}

impl DurableWorkspaceRootRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> DurableWorkspaceRootRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for DurableWorkspaceRootRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid durable workspace root field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for DurableWorkspaceRootRecordError {}

#[derive(Clone, PartialEq, Eq)]
pub struct DurableWorkspaceRootRecord {
    pub workspace_key: String,
    pub node_id: String,
    pub environment_id: String,
    pub root_fingerprint: String,
    pub record_hash: String,
    pub created_at: i64,
}

impl DurableWorkspaceRootRecord {
    pub fn validate(&self) -> Result<(), DurableWorkspaceRootRecordError> {
        validate_workspace_key(&self.workspace_key)?;
        validate_text(&self.node_id, "nodeId")?;
        validate_text(&self.environment_id, "environmentId")?;
        validate_digest(&self.root_fingerprint, "rootFingerprint")?;
        validate_digest(&self.record_hash, "recordHash")?;
        if self.created_at < 0 {
            return Err(error(
                "createdAt",
                DurableWorkspaceRootRecordErrorKind::OutOfRange,
            ));
        }
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                DurableWorkspaceRootRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let created_at = self.created_at.to_string();
        digest_parts(&[
            self.workspace_key.as_bytes(),
            self.node_id.as_bytes(),
            self.environment_id.as_bytes(),
            self.root_fingerprint.as_bytes(),
            created_at.as_bytes(),
        ])
    }
}

impl fmt::Debug for DurableWorkspaceRootRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DurableWorkspaceRootRecord")
            .field("workspace_key", &self.workspace_key)
            .field("node_id", &self.node_id)
            .field("environment_id", &self.environment_id)
            .field("root_fingerprint", &"[REDACTED]")
            .field("record_hash", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableWorkspaceRootResolveOutcome {
    Created(DurableWorkspaceRootRecord),
    Existing(DurableWorkspaceRootRecord),
    CapacityExceeded,
    Conflict,
}

pub(crate) fn validate_workspace_key(
    workspace_key: &str,
) -> Result<(), DurableWorkspaceRootRecordError> {
    let Some(raw_uuid) = workspace_key.strip_prefix(WORKSPACE_KEY_PREFIX) else {
        return Err(error(
            "workspaceKey",
            DurableWorkspaceRootRecordErrorKind::InvalidWorkspaceKey,
        ));
    };
    let parsed = Uuid::parse_str(raw_uuid).map_err(|_| {
        error(
            "workspaceKey",
            DurableWorkspaceRootRecordErrorKind::InvalidWorkspaceKey,
        )
    })?;
    if parsed.to_string() != raw_uuid {
        return Err(error(
            "workspaceKey",
            DurableWorkspaceRootRecordErrorKind::InvalidWorkspaceKey,
        ));
    }
    Ok(())
}

fn validate_text(value: &str, field: &'static str) -> Result<(), DurableWorkspaceRootRecordError> {
    if value.is_empty() || value.trim() != value {
        return Err(error(field, DurableWorkspaceRootRecordErrorKind::Empty));
    }
    if value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        return Err(error(field, DurableWorkspaceRootRecordErrorKind::TooLong));
    }
    Ok(())
}

fn validate_digest(
    value: &str,
    field: &'static str,
) -> Result<(), DurableWorkspaceRootRecordError> {
    let Some(hex) = value.strip_prefix(DIGEST_PREFIX) else {
        return Err(error(
            field,
            DurableWorkspaceRootRecordErrorKind::InvalidDigest,
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(
            field,
            DurableWorkspaceRootRecordErrorKind::InvalidDigest,
        ));
    }
    Ok(())
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.durable-workspace-root.v1\0");
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn error(
    field: &'static str,
    kind: DurableWorkspaceRootRecordErrorKind,
) -> DurableWorkspaceRootRecordError {
    DurableWorkspaceRootRecordError { field, kind }
}
