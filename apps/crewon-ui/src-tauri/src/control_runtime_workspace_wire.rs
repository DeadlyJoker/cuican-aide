use serde::Deserialize;
use serde::Serialize;

use crate::workspace_native::valid_id;
use crate::workspace_native::DesktopWorkspaceAuthority;
use crate::workspace_native::WorkspaceNativeError;
use crate::workspace_native::MAX_SAFE_REVISION;

const STATUS_SCHEMA: &str = "crewon.desktop-workspace-status.v0";
const ERROR_SCHEMA: &str = "crewon.desktop-workspace-error.v0";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DesktopWorkspaceAvailability {
    Available,
    Transitioning,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopWorkspaceStatus {
    schema_version: &'static str,
    availability: DesktopWorkspaceAvailability,
    revision: u64,
    supervisor_generation: u64,
    current: Option<DesktopWorkspaceCurrent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWorkspaceCurrent {
    display_name: String,
}

impl DesktopWorkspaceStatus {
    pub(super) fn project(
        authority: &DesktopWorkspaceAuthority,
        availability: DesktopWorkspaceAvailability,
        supervisor_generation: u64,
    ) -> Result<Self, DesktopWorkspaceError> {
        if authority.current_revision() > MAX_SAFE_REVISION
            || supervisor_generation > MAX_SAFE_REVISION
        {
            return Err(DesktopWorkspaceError::internal(
                "desktop_workspace_authority_corrupt",
            ));
        }
        let current = authority
            .current_snapshot()
            .map(|workspace| {
                let display_name = workspace.display_name();
                if display_name.is_empty()
                    || display_name.len() > 255
                    || display_name.chars().any(char::is_control)
                    || display_name.contains('/')
                    || display_name.contains('\\')
                    || display_name.to_ascii_lowercase().starts_with("file:")
                    || display_name.to_ascii_lowercase().starts_with("http:")
                    || display_name.to_ascii_lowercase().starts_with("https:")
                {
                    return Err(DesktopWorkspaceError::internal(
                        "desktop_workspace_authority_corrupt",
                    ));
                }
                Ok(DesktopWorkspaceCurrent {
                    display_name: display_name.to_string(),
                })
            })
            .transpose()?;
        Ok(Self {
            schema_version: STATUS_SCHEMA,
            availability,
            revision: authority.current_revision(),
            supervisor_generation,
            current,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DesktopWorkspaceMutationRequest {
    pub(super) expected_revision: u64,
    pub(super) idempotency_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MutationRequestWire {
    expected_revision: u64,
    idempotency_key: String,
}

impl DesktopWorkspaceMutationRequest {
    pub(super) fn parse(value: Option<serde_json::Value>) -> Result<Self, DesktopWorkspaceError> {
        let request: MutationRequestWire =
            serde_json::from_value(value.ok_or_else(DesktopWorkspaceError::request_invalid)?)
                .map_err(|_| DesktopWorkspaceError::request_invalid())?;
        if request.expected_revision > MAX_SAFE_REVISION
            || request.idempotency_key.len() > 256
            || request.idempotency_key.trim() != request.idempotency_key
            || request.idempotency_key.chars().any(char::is_control)
            || !valid_id(&request.idempotency_key)
        {
            return Err(DesktopWorkspaceError::request_invalid());
        }
        Ok(Self {
            expected_revision: request.expected_revision,
            idempotency_key: request.idempotency_key,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DesktopWorkspaceSelectOutcome {
    Committed,
    UserCanceled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct DesktopWorkspaceSelectResponse {
    pub(super) outcome: DesktopWorkspaceSelectOutcome,
    pub(super) snapshot: DesktopWorkspaceStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DesktopWorkspaceClearOutcome {
    Committed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct DesktopWorkspaceClearResponse {
    pub(super) outcome: DesktopWorkspaceClearOutcome,
    pub(super) snapshot: DesktopWorkspaceStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DesktopWorkspaceCertainty {
    NotSent,
    PossiblySent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopWorkspaceError {
    schema_version: &'static str,
    status: u16,
    code: &'static str,
    certainty: DesktopWorkspaceCertainty,
}

impl DesktopWorkspaceError {
    pub(super) fn new(
        status: u16,
        code: &'static str,
        certainty: DesktopWorkspaceCertainty,
    ) -> Self {
        Self {
            schema_version: ERROR_SCHEMA,
            status,
            code,
            certainty,
        }
    }

    pub(super) fn request_invalid() -> Self {
        Self::new(
            400,
            "desktop_workspace_request_invalid",
            DesktopWorkspaceCertainty::NotSent,
        )
    }

    pub(super) fn conflict() -> Self {
        Self::new(
            409,
            "desktop_workspace_authority_conflict",
            DesktopWorkspaceCertainty::NotSent,
        )
    }

    pub(super) fn transitioning() -> Self {
        Self::new(
            409,
            "desktop_workspace_transitioning",
            DesktopWorkspaceCertainty::NotSent,
        )
    }

    pub(super) fn active_authority() -> Self {
        Self::new(
            409,
            "desktop_workspace_active_authority",
            DesktopWorkspaceCertainty::NotSent,
        )
    }

    pub(super) fn aborted() -> Self {
        Self::new(
            503,
            "desktop_workspace_mutation_aborted",
            DesktopWorkspaceCertainty::PossiblySent,
        )
    }

    pub(super) fn unavailable() -> Self {
        Self::new(
            503,
            "desktop_workspace_supervisor_unavailable",
            DesktopWorkspaceCertainty::NotSent,
        )
    }

    pub(super) fn internal(code: &'static str) -> Self {
        Self::new(500, code, DesktopWorkspaceCertainty::PossiblySent)
    }

    pub(super) fn internal_not_sent(code: &'static str) -> Self {
        Self::new(500, code, DesktopWorkspaceCertainty::NotSent)
    }

    pub(super) fn from_native(error: WorkspaceNativeError) -> Self {
        match error {
            WorkspaceNativeError::AuthorityInvalid => {
                Self::internal("desktop_workspace_authority_corrupt")
            }
            WorkspaceNativeError::AuthorityConflict => Self::conflict(),
            WorkspaceNativeError::AuthorityRecoveryRequired => Self::transitioning(),
            WorkspaceNativeError::AuthorityUnavailable => Self::unavailable(),
            WorkspaceNativeError::AuthorityMutationUnknown => {
                Self::internal("desktop_workspace_authority_mutation_unknown")
            }
            WorkspaceNativeError::MaterialGenerationFailed
            | WorkspaceNativeError::PayloadInvalid => {
                Self::internal("desktop_workspace_runtime_invalid")
            }
        }
    }
}

#[cfg(test)]
#[path = "control_runtime_workspace_wire_tests.rs"]
mod tests;
