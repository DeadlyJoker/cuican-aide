use serde::Deserialize;
use serde::Serialize;
use std::error::Error;
use std::fmt;

const MAX_TARGET_TOKEN_LENGTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionTargetKind {
    Crewon,
    Agent,
    Team,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ExecutionTargetSelection {
    Crewon,
    Agent { id: String },
    Team { id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetAuthorization {
    Authorized,
    AuthRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetRuntimeAvailability {
    Ready,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionTargetCatalogRecord {
    pub kind: ExecutionTargetKind,
    pub id: String,
    pub token: String,
    pub authorization: TargetAuthorization,
    pub runtime_availability: TargetRuntimeAvailability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionStrategy {
    Single,
    Team,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetAvailability {
    Ready,
    AuthRequired,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedExecutionTarget {
    pub kind: ExecutionTargetKind,
    pub token: String,
    pub execution_strategy: ExecutionStrategy,
    pub availability: TargetAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionTargetError {
    InvalidToken,
    TargetNotFound {
        kind: ExecutionTargetKind,
        id: String,
    },
    TargetKindNotSelectable(ExecutionTargetKind),
}

impl fmt::Display for ExecutionTargetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidToken => formatter.write_str("execution target token is invalid"),
            Self::TargetNotFound { kind, id } => {
                write!(formatter, "execution target {kind:?}/{id} was not found")
            }
            Self::TargetKindNotSelectable(kind) => {
                write!(formatter, "catalog target kind {kind:?} is not selectable")
            }
        }
    }
}

impl Error for ExecutionTargetError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionTargetResolver {
    crewon_token: String,
    team_runtime_availability: TargetRuntimeAvailability,
}

impl ExecutionTargetResolver {
    pub fn new(
        crewon_token: impl Into<String>,
        team_runtime_availability: TargetRuntimeAvailability,
    ) -> Result<Self, ExecutionTargetError> {
        let crewon_token = crewon_token.into();
        validate_token(&crewon_token)?;
        Ok(Self {
            crewon_token,
            team_runtime_availability,
        })
    }

    pub fn resolve(
        &self,
        selection: &ExecutionTargetSelection,
        catalog: &[ExecutionTargetCatalogRecord],
    ) -> Result<ResolvedExecutionTarget, ExecutionTargetError> {
        match selection {
            ExecutionTargetSelection::Crewon => Ok(ResolvedExecutionTarget {
                kind: ExecutionTargetKind::Crewon,
                token: self.crewon_token.clone(),
                execution_strategy: ExecutionStrategy::Single,
                availability: TargetAvailability::Ready,
            }),
            ExecutionTargetSelection::Agent { id } => {
                self.resolve_catalog_target(ExecutionTargetKind::Agent, id, catalog)
            }
            ExecutionTargetSelection::Team { id } => {
                self.resolve_catalog_target(ExecutionTargetKind::Team, id, catalog)
            }
        }
    }

    fn resolve_catalog_target(
        &self,
        kind: ExecutionTargetKind,
        id: &str,
        catalog: &[ExecutionTargetCatalogRecord],
    ) -> Result<ResolvedExecutionTarget, ExecutionTargetError> {
        if kind == ExecutionTargetKind::Crewon {
            return Err(ExecutionTargetError::TargetKindNotSelectable(kind));
        }
        let record = catalog
            .iter()
            .find(|record| record.kind == kind && record.id == id)
            .ok_or_else(|| ExecutionTargetError::TargetNotFound {
                kind,
                id: id.to_string(),
            })?;
        validate_token(&record.token)?;

        let runtime_availability = if kind == ExecutionTargetKind::Team
            && self.team_runtime_availability != TargetRuntimeAvailability::Ready
        {
            self.team_runtime_availability
        } else {
            record.runtime_availability
        };
        let availability = match (record.authorization, runtime_availability) {
            (TargetAuthorization::AuthRequired, _) => TargetAvailability::AuthRequired,
            (TargetAuthorization::Authorized, TargetRuntimeAvailability::Ready) => {
                TargetAvailability::Ready
            }
            (TargetAuthorization::Authorized, TargetRuntimeAvailability::Unavailable) => {
                TargetAvailability::Unavailable
            }
            (TargetAuthorization::Authorized, TargetRuntimeAvailability::Error) => {
                TargetAvailability::Error
            }
        };

        Ok(ResolvedExecutionTarget {
            kind,
            token: record.token.clone(),
            execution_strategy: match kind {
                ExecutionTargetKind::Crewon | ExecutionTargetKind::Agent => {
                    ExecutionStrategy::Single
                }
                ExecutionTargetKind::Team => ExecutionStrategy::Team,
            },
            availability,
        })
    }
}

fn validate_token(token: &str) -> Result<(), ExecutionTargetError> {
    if token.is_empty()
        || token.len() > MAX_TARGET_TOKEN_LENGTH
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ExecutionTargetError::InvalidToken);
    }
    Ok(())
}

#[cfg(test)]
#[path = "execution_target_tests.rs"]
mod tests;
