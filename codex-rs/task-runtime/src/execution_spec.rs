use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;

use crate::ExecutionSpecDigest;
use crate::ExecutionSpecId;
use crate::ModelError;
use crate::ModelErrorKind;

/// Non-zero immutable revision of one server-owned execution specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ExecutionSpecRevision(u64);

impl ExecutionSpecRevision {
    /// Constructs an execution specification revision starting at one.
    pub fn new(value: u64) -> Result<Self, ModelError> {
        if value == 0 {
            return Err(ModelError::new(
                "executionSpecRevision",
                ModelErrorKind::OutOfRange,
            ));
        }
        Ok(Self(value))
    }

    /// Returns the numeric immutable revision.
    pub fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ExecutionSpecRevision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Exact metadata-only reference to immutable execution input owned by an adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionSpecRef {
    execution_spec_id: ExecutionSpecId,
    revision: ExecutionSpecRevision,
    digest: ExecutionSpecDigest,
}

impl ExecutionSpecRef {
    /// Constructs an exact reference without accepting prompt, context, or credentials.
    pub fn new(
        execution_spec_id: ExecutionSpecId,
        revision: ExecutionSpecRevision,
        digest: ExecutionSpecDigest,
    ) -> Self {
        Self {
            execution_spec_id,
            revision,
            digest,
        }
    }

    /// Returns the stable execution specification identifier.
    pub fn execution_spec_id(&self) -> &ExecutionSpecId {
        &self.execution_spec_id
    }

    /// Returns the exact immutable revision.
    pub fn revision(&self) -> ExecutionSpecRevision {
        self.revision
    }

    /// Returns the canonical digest of the resolved execution specification.
    pub fn digest(&self) -> &ExecutionSpecDigest {
        &self.digest
    }
}
