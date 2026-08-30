use std::fmt;

use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use crate::durable_workspace_records::validate_workspace_key;

pub const MAX_OFFICE_MIGRATION_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_OFFICE_MIGRATION_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORD_ID_BYTES: usize = 128;
const MAX_SOURCE_REVISION_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OfficeMigrationPhase {
    Quiescing,
    Importing,
    Imported,
    Active,
}

impl OfficeMigrationPhase {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Quiescing => "quiescing",
            Self::Importing => "importing",
            Self::Imported => "imported",
            Self::Active => "active",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "quiescing" => Ok(Self::Quiescing),
            "importing" => Ok(Self::Importing),
            "imported" => Ok(Self::Imported),
            "active" => Ok(Self::Active),
            _ => anyhow::bail!("invalid Office migration phase"),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct OfficeMigrationJournalRecord {
    pub record_id: String,
    pub workspace_key: String,
    pub source_revision: String,
    pub source_digest: String,
    pub source_bytes: u64,
    pub phase: OfficeMigrationPhase,
    pub journal_revision: u64,
    pub snapshot_digest: Option<String>,
    pub snapshot_json: Option<String>,
    pub record_hash: String,
    pub started_at: i64,
    pub updated_at: i64,
    pub imported_at: Option<i64>,
}

impl OfficeMigrationJournalRecord {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_record_id(&self.record_id)?;
        validate_workspace_key(&self.workspace_key)?;
        validate_source_revision(&self.source_revision)?;
        validate_digest(&self.source_digest)?;
        if self.source_bytes == 0
            || self.source_bytes > MAX_OFFICE_MIGRATION_SOURCE_BYTES
            || self.journal_revision == 0
            || self.started_at < 0
            || self.updated_at < self.started_at
            || self
                .imported_at
                .is_some_and(|value| value < self.started_at)
        {
            anyhow::bail!("invalid Office migration journal lifecycle");
        }
        match self.phase {
            OfficeMigrationPhase::Quiescing | OfficeMigrationPhase::Importing => {
                if self.snapshot_digest.is_some()
                    || self.snapshot_json.is_some()
                    || self.imported_at.is_some()
                {
                    anyhow::bail!("pre-import Office migration journal contains a snapshot");
                }
            }
            OfficeMigrationPhase::Imported | OfficeMigrationPhase::Active => {
                let snapshot_digest = self
                    .snapshot_digest
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("imported Office migration has no digest"))?;
                let snapshot_json = self
                    .snapshot_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("imported Office migration has no snapshot"))?;
                validate_snapshot(snapshot_json, snapshot_digest)?;
                if self.imported_at.is_none() {
                    anyhow::bail!("imported Office migration has no importedAt");
                }
            }
        }
        validate_digest(&self.record_hash)?;
        if self.record_hash != self.canonical_hash() {
            anyhow::bail!("Office migration journal hash mismatch");
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let source_bytes = self.source_bytes.to_string();
        let journal_revision = self.journal_revision.to_string();
        let started_at = self.started_at.to_string();
        let updated_at = self.updated_at.to_string();
        let imported_at = self.imported_at.map(|value| value.to_string());
        digest_parts(&[
            self.record_id.as_bytes(),
            self.workspace_key.as_bytes(),
            self.source_revision.as_bytes(),
            self.source_digest.as_bytes(),
            source_bytes.as_bytes(),
            self.phase.as_str().as_bytes(),
            journal_revision.as_bytes(),
            self.snapshot_digest
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
            started_at.as_bytes(),
            updated_at.as_bytes(),
            imported_at.as_deref().unwrap_or_default().as_bytes(),
        ])
    }
}

impl fmt::Debug for OfficeMigrationJournalRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfficeMigrationJournalRecord")
            .field("record_id", &self.record_id)
            .field("workspace_key", &self.workspace_key)
            .field("source", &"[REDACTED]")
            .field("source_bytes", &self.source_bytes)
            .field("phase", &self.phase)
            .field("journal_revision", &self.journal_revision)
            .field(
                "snapshot",
                &self.snapshot_json.as_ref().map(|_| "[REDACTED]"),
            )
            .field("started_at", &self.started_at)
            .field("updated_at", &self.updated_at)
            .field("imported_at", &self.imported_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfficeMigrationStart {
    pub record_id: String,
    pub workspace_key: String,
    pub source_revision: String,
    pub source_digest: String,
    pub source_bytes: u64,
    pub started_at: i64,
}

impl OfficeMigrationStart {
    pub(crate) fn journal_record(&self) -> OfficeMigrationJournalRecord {
        let mut record = OfficeMigrationJournalRecord {
            record_id: self.record_id.clone(),
            workspace_key: self.workspace_key.clone(),
            source_revision: self.source_revision.clone(),
            source_digest: self.source_digest.clone(),
            source_bytes: self.source_bytes,
            phase: OfficeMigrationPhase::Quiescing,
            journal_revision: 1,
            snapshot_digest: None,
            snapshot_json: None,
            record_hash: String::new(),
            started_at: self.started_at,
            updated_at: self.started_at,
            imported_at: None,
        };
        record.record_hash = record.canonical_hash();
        record
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        self.journal_record().validate()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfficeMigrationBeginImport {
    pub record_id: String,
    pub source_digest: String,
    pub expected_journal_revision: u64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfficeMigrationAdvanceSource {
    pub record_id: String,
    pub expected_source_digest: String,
    pub expected_journal_revision: u64,
    pub source_revision: String,
    pub source_digest: String,
    pub source_bytes: u64,
    pub updated_at: i64,
}

impl OfficeMigrationAdvanceSource {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_record_id(&self.record_id)?;
        validate_digest(&self.expected_source_digest)?;
        validate_source_revision(&self.source_revision)?;
        validate_digest(&self.source_digest)?;
        if self.expected_journal_revision == 0
            || self.source_bytes == 0
            || self.source_bytes > MAX_OFFICE_MIGRATION_SOURCE_BYTES
            || self.updated_at < 0
        {
            anyhow::bail!("invalid Office migration source advance");
        }
        Ok(())
    }
}

impl OfficeMigrationBeginImport {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_record_id(&self.record_id)?;
        validate_digest(&self.source_digest)?;
        if self.expected_journal_revision == 0 || self.updated_at < 0 {
            anyhow::bail!("invalid Office migration import transition");
        }
        Ok(())
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct OfficeMigrationCommit {
    pub record_id: String,
    pub source_digest: String,
    pub expected_journal_revision: u64,
    pub snapshot_digest: String,
    pub snapshot_json: String,
    pub imported_at: i64,
}

impl OfficeMigrationCommit {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_record_id(&self.record_id)?;
        validate_digest(&self.source_digest)?;
        validate_snapshot(&self.snapshot_json, &self.snapshot_digest)?;
        if self.expected_journal_revision == 0 || self.imported_at < 0 {
            anyhow::bail!("invalid Office migration commit");
        }
        Ok(())
    }
}

impl fmt::Debug for OfficeMigrationCommit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfficeMigrationCommit")
            .field("record_id", &self.record_id)
            .field("source", &"[REDACTED]")
            .field("expected_journal_revision", &self.expected_journal_revision)
            .field("snapshot", &"[REDACTED]")
            .field("imported_at", &self.imported_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OfficeMigrationStartOutcome {
    Started(OfficeMigrationJournalRecord),
    Existing(OfficeMigrationJournalRecord),
    Conflict,
    WorkspaceNotFound,
    CapacityExceeded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OfficeMigrationMutationOutcome {
    Updated(OfficeMigrationJournalRecord),
    Existing(OfficeMigrationJournalRecord),
    NotFound,
    Conflict,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OfficeLegacyWriteStatus {
    Writable,
    Fenced {
        phase: OfficeMigrationPhase,
        journal_revision: u64,
    },
}

pub fn office_migration_snapshot_digest(snapshot_json: &str) -> String {
    let digest = Sha256::digest(snapshot_json.as_bytes());
    format!("sha256:{digest:x}")
}

fn validate_snapshot(snapshot_json: &str, snapshot_digest: &str) -> anyhow::Result<()> {
    if snapshot_json.is_empty() || snapshot_json.len() > MAX_OFFICE_MIGRATION_SNAPSHOT_BYTES {
        anyhow::bail!("invalid Office migration snapshot size");
    }
    let value: Value = serde_json::from_str(snapshot_json)?;
    if !value.is_object() {
        anyhow::bail!("Office migration snapshot must be a JSON object");
    }
    validate_digest(snapshot_digest)?;
    if office_migration_snapshot_digest(snapshot_json) != snapshot_digest {
        anyhow::bail!("Office migration snapshot digest mismatch");
    }
    Ok(())
}

fn validate_record_id(value: &str) -> anyhow::Result<()> {
    validate_text(value, MAX_RECORD_ID_BYTES, "recordId")
}

fn validate_source_revision(value: &str) -> anyhow::Result<()> {
    validate_text(value, MAX_SOURCE_REVISION_BYTES, "sourceRevision")
}

fn validate_text(value: &str, max_bytes: usize, field: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        anyhow::bail!("invalid Office migration {field}");
    }
    Ok(())
}

fn validate_digest(value: &str) -> anyhow::Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        anyhow::bail!("invalid Office migration digest");
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        anyhow::bail!("invalid Office migration digest");
    }
    Ok(())
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.office-migration-journal.v1\0");
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("sha256:{:x}", hasher.finalize())
}
