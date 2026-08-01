use std::fmt;

pub const MAX_CLOUD_AGENT_THREAD_SUMMARY_SYNC_PAGE_SIZE: u32 = 100;
pub const MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentThreadSummarySyncCandidate {
    pub thread_id: String,
    pub last_turn_id: String,
    pub preview: Option<String>,
    pub projection_revision: u64,
    pub metadata_sync_revision: u64,
    pub updated_at: i64,
}

impl CloudAgentThreadSummarySyncCandidate {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_id(&self.thread_id)?;
        validate_id(&self.last_turn_id)?;
        if self.projection_revision == 0
            || self.metadata_sync_revision >= self.projection_revision
            || self.updated_at < 0
            || self.preview.as_ref().is_some_and(|preview| {
                preview.is_empty() || preview.len() > MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES
            })
        {
            anyhow::bail!("invalid Cloud Agent Thread summary sync candidate");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentThreadSummarySyncPage {
    pub data: Vec<CloudAgentThreadSummarySyncCandidate>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentThreadSummarySyncRequest {
    pub thread_id: String,
    pub last_turn_id: String,
    pub expected_projection_revision: u64,
    pub preview: String,
    pub expected_updated_at: i64,
}

impl CloudAgentThreadSummarySyncRequest {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_id(&self.thread_id)?;
        validate_id(&self.last_turn_id)?;
        if self.expected_projection_revision == 0
            || self.preview.trim().is_empty()
            || self.preview.len() > MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES
            || self.expected_updated_at < 0
        {
            anyhow::bail!("invalid Cloud Agent Thread summary sync request");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentThreadSummarySyncOutcome {
    Applied,
    ExistingSame,
    Stale,
    NotFound,
    ThreadMetadataMissing,
}

impl fmt::Display for CloudAgentThreadSummarySyncOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

fn validate_id(value: &str) -> anyhow::Result<()> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        anyhow::bail!("invalid Cloud Agent Thread summary id");
    }
    Ok(())
}
