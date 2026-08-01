use crate::CloudAgentTurnRecord;

pub const MAX_CLOUD_AGENT_TURN_PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentTurnSortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnPageAnchor {
    pub turn_id: String,
    pub include_anchor: bool,
}

impl CloudAgentTurnPageAnchor {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_id(&self.turn_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnPageQuery {
    pub thread_id: String,
    pub anchor: Option<CloudAgentTurnPageAnchor>,
    pub limit: u32,
    pub sort_direction: CloudAgentTurnSortDirection,
}

impl CloudAgentTurnPageQuery {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_id(&self.thread_id)?;
        if self.limit == 0 || self.limit > MAX_CLOUD_AGENT_TURN_PAGE_SIZE {
            anyhow::bail!("invalid Cloud Agent Turn page limit");
        }
        if let Some(anchor) = &self.anchor {
            anchor.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnPage {
    pub data: Vec<CloudAgentTurnRecord>,
    pub has_more: bool,
}

fn validate_id(value: &str) -> anyhow::Result<()> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        anyhow::bail!("invalid Cloud Agent Turn page id");
    }
    Ok(())
}
