use std::collections::BTreeSet;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use crewon_app_server_protocol::ExpertRole;
use crewon_app_server_protocol::ExpertTeamConfig;
use crewon_app_server_protocol::ExpertTeamCreateParams;
use crewon_app_server_protocol::ExpertTeamCreateResponse;
use crewon_app_server_protocol::ExpertTeamListParams;
use crewon_app_server_protocol::ExpertTeamListResponse;
use crewon_app_server_protocol::ExpertTeamReadParams;
use crewon_app_server_protocol::ExpertTeamReadResponse;
use crewon_app_server_protocol::ExpertTeamRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use serde::Deserialize;
use serde::Serialize;
use tokio::fs;
use uuid::Uuid;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const EXPERTS_RECORD_VERSION: u16 = 1;
const EXPERTS_RECORD_KIND: &str = "experts";
const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 100;
const MAX_EXPERT_COUNT: usize = 8;
const MIN_EXPERT_COUNT: usize = 2;
const MAX_TITLE_CHARS: usize = 120;
const MAX_GOAL_CHARS: usize = 4_000;
const MAX_ROLE_NAME_CHARS: usize = 120;
const MAX_ROLE_CHARS: usize = 512;
const MAX_INSTRUCTIONS_CHARS: usize = 4_000;
const MAX_SCOPE_FIELD_CHARS: usize = 512;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const LEADER_AGENT_TYPE: &str = "worker";
const EXPERT_AGENT_TYPES: [&str; 2] = ["explorer", "worker"];

#[derive(Clone, Default)]
pub(crate) struct ExpertsRequestProcessor;

/// Stable ownership scope derived by the app server, never by request payload fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExpertTeamAuthority {
    owner_subject: String,
    tenant_id: Option<String>,
    space_id: Option<String>,
}

impl ExpertTeamAuthority {
    pub(crate) fn new(
        owner_subject: String,
        tenant_id: Option<String>,
        space_id: Option<String>,
    ) -> Result<Self, JSONRPCErrorError> {
        if tenant_id.is_none() && space_id.is_some() {
            return Err(invalid_params(
                "Experts authority cannot contain a space without a tenant",
            ));
        }
        Ok(Self {
            owner_subject: bounded_server_field(
                "ownerSubject",
                &owner_subject,
                MAX_SCOPE_FIELD_CHARS,
            )?,
            tenant_id: bounded_optional_server_field(
                "tenantId",
                tenant_id.as_deref(),
                MAX_SCOPE_FIELD_CHARS,
            )?,
            space_id: bounded_optional_server_field(
                "spaceId",
                space_id.as_deref(),
                MAX_SCOPE_FIELD_CHARS,
            )?,
        })
    }
}

impl ExpertsRequestProcessor {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) async fn list(
        &self,
        workspace_root: &Path,
        authority: &ExpertTeamAuthority,
        workspace: &WorkspaceRef,
        params: ExpertTeamListParams,
    ) -> Result<ExpertTeamListResponse, JSONRPCErrorError> {
        validate_server_scope(authority, workspace)?;
        validate_requested_workspace_key(&params.workspace_key, workspace)?;
        let offset = parse_cursor(params.cursor)?;
        let limit = normalize_limit(params.limit);
        let directory = ensure_experts_directory(workspace_root).await?;
        let mut entries = fs::read_dir(&directory).await.map_err(map_io_error)?;
        let mut records = Vec::new();
        while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let Some(record) = read_expert_team_record_by_path(workspace_root, &path).await? else {
                continue;
            };
            if authority_matches(&record.config, authority, workspace) {
                records.push(record);
            }
        }
        records.sort_by(|left, right| right.config.experts_id.cmp(&left.config.experts_id));
        let next_cursor = if records.len() > offset.saturating_add(limit) {
            Some(offset.saturating_add(limit).to_string())
        } else {
            None
        };
        Ok(ExpertTeamListResponse {
            data: records.into_iter().skip(offset).take(limit).collect(),
            next_cursor,
        })
    }

    pub(crate) async fn create(
        &self,
        workspace_root: &Path,
        authority: &ExpertTeamAuthority,
        workspace: &WorkspaceRef,
        params: ExpertTeamCreateParams,
    ) -> Result<ExpertTeamCreateResponse, JSONRPCErrorError> {
        validate_server_scope(authority, workspace)?;
        validate_requested_workspace_key(&params.workspace_key, workspace)?;
        let title = bounded_text(
            "title",
            params.title,
            MAX_TITLE_CHARS,
            TextShape::SingleLine,
        )?;
        let goal = bounded_text("goal", params.goal, MAX_GOAL_CHARS, TextShape::Multiline)?;
        let leader = normalize_role("leader", params.leader)?;
        if leader.agent_type != LEADER_AGENT_TYPE {
            return Err(invalid_params("leader.agentType must be worker"));
        }
        if !(MIN_EXPERT_COUNT..=MAX_EXPERT_COUNT).contains(&params.experts.len()) {
            return Err(invalid_params(format!(
                "experts must contain between {MIN_EXPERT_COUNT} and {MAX_EXPERT_COUNT} roles"
            )));
        }
        let experts = params
            .experts
            .into_iter()
            .enumerate()
            .map(|(index, role)| normalize_role(&format!("experts[{index}]"), role))
            .collect::<Result<Vec<_>, _>>()?;
        validate_unique_roles(&leader, &experts)?;

        let experts_id = format!("experts-{}", Uuid::now_v7());
        let config = ExpertTeamConfig {
            experts_id: experts_id.clone(),
            title,
            goal,
            leader,
            experts,
            record_revision: Uuid::now_v7().to_string(),
            workspace_key: bounded_server_field(
                "workspaceKey",
                &workspace.workspace_key,
                MAX_SCOPE_FIELD_CHARS,
            )?,
            owner_subject: bounded_server_field(
                "ownerSubject",
                &authority.owner_subject,
                MAX_SCOPE_FIELD_CHARS,
            )?,
            tenant_id: bounded_optional_server_field(
                "tenantId",
                authority.tenant_id.as_deref(),
                MAX_SCOPE_FIELD_CHARS,
            )?,
            space_id: bounded_optional_server_field(
                "spaceId",
                authority.space_id.as_deref(),
                MAX_SCOPE_FIELD_CHARS,
            )?,
        };
        let directory = ensure_experts_directory(workspace_root).await?;
        let file_path = directory.join(format!("{experts_id}.json"));
        if fs::try_exists(&file_path).await.map_err(map_io_error)? {
            return Err(internal_error("generated Experts identity already exists"));
        }
        write_record(&file_path, &config).await?;
        Ok(ExpertTeamCreateResponse {
            record: ExpertTeamRecord {
                file_path: file_path.to_string_lossy().into_owned(),
                config,
            },
        })
    }

    pub(crate) async fn read(
        &self,
        workspace_root: &Path,
        authority: &ExpertTeamAuthority,
        workspace: &WorkspaceRef,
        params: ExpertTeamReadParams,
    ) -> Result<ExpertTeamReadResponse, JSONRPCErrorError> {
        validate_server_scope(authority, workspace)?;
        validate_requested_workspace_key(&params.workspace_key, workspace)?;
        let record = read_expert_team_record(workspace_root, &params.experts_id)
            .await?
            .filter(|record| authority_matches(&record.config, authority, workspace));
        Ok(ExpertTeamReadResponse { record })
    }
}

/// Reads an Experts definition by its opaque server-generated identity.
pub(crate) async fn read_expert_team_record(
    workspace_root: &Path,
    experts_id: &str,
) -> Result<Option<ExpertTeamRecord>, JSONRPCErrorError> {
    validate_experts_id(experts_id)?;
    let directory = ensure_experts_directory(workspace_root).await?;
    let path = directory.join(format!("{experts_id}.json"));
    read_expert_team_record_by_path(workspace_root, &path).await
}

/// Reads an Experts definition from a previously returned server-owned file path.
pub(crate) async fn read_expert_team_record_by_file_path(
    workspace_root: &Path,
    file_path: &str,
) -> Result<Option<ExpertTeamRecord>, JSONRPCErrorError> {
    let requested = PathBuf::from(file_path);
    let requested = if requested.is_absolute() {
        requested
    } else {
        workspace_root.join(requested)
    };
    read_expert_team_record_by_path(workspace_root, &requested).await
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedExpertTeamRecord {
    version: u16,
    kind: String,
    config: ExpertTeamConfig,
}

#[derive(Clone, Copy)]
enum TextShape {
    SingleLine,
    Multiline,
}

async fn read_expert_team_record_by_path(
    workspace_root: &Path,
    requested: &Path,
) -> Result<Option<ExpertTeamRecord>, JSONRPCErrorError> {
    let directory = ensure_experts_directory(workspace_root).await?;
    let metadata = match fs::symlink_metadata(requested).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(map_io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_params(
            "Experts record must be a regular server-owned file",
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAX_RECORD_BYTES as u64 {
        return Err(invalid_params("Experts record exceeds its bounded size"));
    }
    let canonical_path = fs::canonicalize(requested).await.map_err(map_io_error)?;
    if canonical_path.parent() != Some(directory.as_path())
        || canonical_path
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("json")
    {
        return Err(invalid_params(
            "Experts record path is outside the workspace Experts directory",
        ));
    }
    let bytes = fs::read(&canonical_path).await.map_err(map_io_error)?;
    let persisted = serde_json::from_slice::<PersistedExpertTeamRecord>(&bytes)
        .map_err(|error| internal_error(format!("Experts record is corrupt: {error}")))?;
    if persisted.version != EXPERTS_RECORD_VERSION || persisted.kind != EXPERTS_RECORD_KIND {
        return Err(invalid_params("Experts record has an unsupported format"));
    }
    validate_config(&persisted.config)?;
    if canonical_path.file_stem().and_then(|stem| stem.to_str())
        != Some(persisted.config.experts_id.as_str())
    {
        return Err(invalid_params(
            "Experts record identity does not match its server-owned file",
        ));
    }
    Ok(Some(ExpertTeamRecord {
        file_path: canonical_path.to_string_lossy().into_owned(),
        config: persisted.config,
    }))
}

async fn write_record(
    file_path: &Path,
    config: &ExpertTeamConfig,
) -> Result<(), JSONRPCErrorError> {
    let persisted = PersistedExpertTeamRecord {
        version: EXPERTS_RECORD_VERSION,
        kind: EXPERTS_RECORD_KIND.to_string(),
        config: config.clone(),
    };
    let mut contents = serde_json::to_string_pretty(&persisted)
        .map_err(|error| internal_error(format!("failed to serialize Experts record: {error}")))?;
    contents.push('\n');
    if contents.len() > MAX_RECORD_BYTES {
        return Err(invalid_params("Experts record exceeds its bounded size"));
    }
    let file_path = file_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crewon_core::path_utils::write_atomically(&file_path, &contents)
    })
    .await
    .map_err(|error| internal_error(format!("failed to join Experts record write: {error}")))?
    .map_err(map_io_error)
}

async fn ensure_experts_directory(workspace_root: &Path) -> Result<PathBuf, JSONRPCErrorError> {
    let canonical_root = fs::canonicalize(workspace_root)
        .await
        .map_err(map_io_error)?;
    let crewon_directory = canonical_root.join(".crewon");
    ensure_regular_directory(&crewon_directory).await?;
    let experts_directory = crewon_directory.join("experts");
    ensure_regular_directory(&experts_directory).await?;
    let canonical_directory = fs::canonicalize(&experts_directory)
        .await
        .map_err(map_io_error)?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err(invalid_params(
            "Experts directory escapes the server-owned workspace root",
        ));
    }
    Ok(canonical_directory)
}

async fn ensure_regular_directory(path: &Path) -> Result<(), JSONRPCErrorError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(invalid_params(
                    "Experts storage must use regular workspace directories",
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => match fs::create_dir(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(path).await.map_err(map_io_error)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(invalid_params(
                        "Experts storage must use regular workspace directories",
                    ));
                }
            }
            Err(error) => return Err(map_io_error(error)),
        },
        Err(error) => return Err(map_io_error(error)),
    }
    Ok(())
}

fn validate_server_scope(
    authority: &ExpertTeamAuthority,
    workspace: &WorkspaceRef,
) -> Result<(), JSONRPCErrorError> {
    if workspace.scope != WorkspaceScope::Conversation {
        return Err(invalid_params(
            "Experts require a Conversation workspace binding",
        ));
    }
    bounded_server_field(
        "workspaceKey",
        &workspace.workspace_key,
        MAX_SCOPE_FIELD_CHARS,
    )?;
    bounded_server_field(
        "ownerSubject",
        &authority.owner_subject,
        MAX_SCOPE_FIELD_CHARS,
    )?;
    bounded_optional_server_field(
        "tenantId",
        authority.tenant_id.as_deref(),
        MAX_SCOPE_FIELD_CHARS,
    )?;
    bounded_optional_server_field(
        "spaceId",
        authority.space_id.as_deref(),
        MAX_SCOPE_FIELD_CHARS,
    )?;
    Ok(())
}

fn validate_requested_workspace_key(
    requested_workspace_key: &str,
    workspace: &WorkspaceRef,
) -> Result<(), JSONRPCErrorError> {
    bounded_server_field(
        "workspaceKey",
        requested_workspace_key,
        MAX_SCOPE_FIELD_CHARS,
    )?;
    if requested_workspace_key != workspace.workspace_key {
        return Err(invalid_params(
            "workspaceKey does not match the server-resolved workspace",
        ));
    }
    Ok(())
}

fn authority_matches(
    config: &ExpertTeamConfig,
    authority: &ExpertTeamAuthority,
    workspace: &WorkspaceRef,
) -> bool {
    config.workspace_key == workspace.workspace_key
        && config.owner_subject == authority.owner_subject
        && config.tenant_id == authority.tenant_id
        && config.space_id == authority.space_id
}

fn validate_config(config: &ExpertTeamConfig) -> Result<(), JSONRPCErrorError> {
    validate_experts_id(&config.experts_id)?;
    bounded_text_ref(
        "title",
        &config.title,
        MAX_TITLE_CHARS,
        TextShape::SingleLine,
    )?;
    bounded_text_ref("goal", &config.goal, MAX_GOAL_CHARS, TextShape::Multiline)?;
    validate_role("leader", &config.leader)?;
    if config.leader.agent_type != LEADER_AGENT_TYPE {
        return Err(invalid_params("leader.agentType must be worker"));
    }
    if !(MIN_EXPERT_COUNT..=MAX_EXPERT_COUNT).contains(&config.experts.len()) {
        return Err(invalid_params(format!(
            "experts must contain between {MIN_EXPERT_COUNT} and {MAX_EXPERT_COUNT} roles"
        )));
    }
    for (index, role) in config.experts.iter().enumerate() {
        validate_role(&format!("experts[{index}]"), role)?;
    }
    validate_unique_roles(&config.leader, &config.experts)?;
    bounded_server_field(
        "recordRevision",
        &config.record_revision,
        MAX_SCOPE_FIELD_CHARS,
    )?;
    bounded_server_field("workspaceKey", &config.workspace_key, MAX_SCOPE_FIELD_CHARS)?;
    bounded_server_field("ownerSubject", &config.owner_subject, MAX_SCOPE_FIELD_CHARS)?;
    bounded_optional_server_field(
        "tenantId",
        config.tenant_id.as_deref(),
        MAX_SCOPE_FIELD_CHARS,
    )?;
    bounded_optional_server_field("spaceId", config.space_id.as_deref(), MAX_SCOPE_FIELD_CHARS)?;
    Ok(())
}

fn normalize_role(field: &str, role: ExpertRole) -> Result<ExpertRole, JSONRPCErrorError> {
    Ok(ExpertRole {
        name: bounded_text(
            &format!("{field}.name"),
            role.name,
            MAX_ROLE_NAME_CHARS,
            TextShape::SingleLine,
        )?,
        role: bounded_text(
            &format!("{field}.role"),
            role.role,
            MAX_ROLE_CHARS,
            TextShape::Multiline,
        )?,
        agent_type: normalize_agent_type(field, role.agent_type)?,
        instructions: role
            .instructions
            .map(|instructions| {
                bounded_text(
                    &format!("{field}.instructions"),
                    instructions,
                    MAX_INSTRUCTIONS_CHARS,
                    TextShape::Multiline,
                )
            })
            .transpose()?,
    })
}

fn validate_role(field: &str, role: &ExpertRole) -> Result<(), JSONRPCErrorError> {
    bounded_text_ref(
        &format!("{field}.name"),
        &role.name,
        MAX_ROLE_NAME_CHARS,
        TextShape::SingleLine,
    )?;
    bounded_text_ref(
        &format!("{field}.role"),
        &role.role,
        MAX_ROLE_CHARS,
        TextShape::Multiline,
    )?;
    validate_agent_type(field, &role.agent_type)?;
    if let Some(instructions) = role.instructions.as_deref() {
        bounded_text_ref(
            &format!("{field}.instructions"),
            instructions,
            MAX_INSTRUCTIONS_CHARS,
            TextShape::Multiline,
        )?;
    }
    Ok(())
}

fn normalize_agent_type(field: &str, agent_type: String) -> Result<String, JSONRPCErrorError> {
    let agent_type = agent_type.trim().to_string();
    validate_agent_type(field, &agent_type)?;
    Ok(agent_type)
}

fn validate_agent_type(field: &str, agent_type: &str) -> Result<(), JSONRPCErrorError> {
    if !EXPERT_AGENT_TYPES.contains(&agent_type) {
        return Err(invalid_params(format!(
            "{field}.agentType must be explorer or worker"
        )));
    }
    Ok(())
}

fn validate_unique_roles(
    leader: &ExpertRole,
    experts: &[ExpertRole],
) -> Result<(), JSONRPCErrorError> {
    let mut names = BTreeSet::new();
    for name in std::iter::once(&leader.name).chain(experts.iter().map(|role| &role.name)) {
        if !names.insert(name.to_lowercase()) {
            return Err(invalid_params("Expert role names must be unique"));
        }
    }
    Ok(())
}

fn bounded_text(
    field: &str,
    value: String,
    max_chars: usize,
    shape: TextShape,
) -> Result<String, JSONRPCErrorError> {
    let value = value.trim().to_string();
    bounded_text_ref(field, &value, max_chars, shape)?;
    Ok(value)
}

fn bounded_text_ref(
    field: &str,
    value: &str,
    max_chars: usize,
    shape: TextShape,
) -> Result<(), JSONRPCErrorError> {
    if value.trim().is_empty() {
        return Err(invalid_params(format!("{field} must not be empty")));
    }
    if value.chars().count() > max_chars {
        return Err(invalid_params(format!(
            "{field} exceeds its {max_chars} character limit"
        )));
    }
    if value.chars().any(|character| {
        character.is_control()
            && !matches!(
                (shape, character),
                (TextShape::Multiline, '\n' | '\r' | '\t')
            )
    }) {
        return Err(invalid_params(format!(
            "{field} contains unsupported control characters"
        )));
    }
    if matches!(shape, TextShape::SingleLine) && (value.contains('\n') || value.contains('\r')) {
        return Err(invalid_params(format!("{field} must be a single line")));
    }
    Ok(())
}

fn bounded_server_field(
    field: &str,
    value: &str,
    max_chars: usize,
) -> Result<String, JSONRPCErrorError> {
    let normalized = bounded_text(field, value.to_string(), max_chars, TextShape::SingleLine)?;
    if normalized != value {
        return Err(invalid_params(format!(
            "{field} is not a canonical server-derived value"
        )));
    }
    Ok(normalized)
}

fn bounded_optional_server_field(
    field: &str,
    value: Option<&str>,
    max_chars: usize,
) -> Result<Option<String>, JSONRPCErrorError> {
    value
        .map(|value| bounded_server_field(field, value, max_chars))
        .transpose()
}

fn validate_experts_id(experts_id: &str) -> Result<(), JSONRPCErrorError> {
    if !experts_id.starts_with("experts-")
        || experts_id.len() > 64
        || !experts_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(invalid_params("expertsId is invalid"));
    }
    Ok(())
}

fn parse_cursor(cursor: Option<String>) -> Result<usize, JSONRPCErrorError> {
    match cursor {
        Some(cursor) => cursor
            .parse::<usize>()
            .map_err(|_| invalid_params("cursor is invalid")),
        None => Ok(0),
    }
}

fn normalize_limit(limit: Option<u32>) -> usize {
    limit
        .unwrap_or(DEFAULT_LIST_LIMIT as u32)
        .clamp(1, MAX_LIST_LIMIT as u32) as usize
}

fn map_io_error(error: io::Error) -> JSONRPCErrorError {
    internal_error(format!("Experts storage failure: {error}"))
}

#[cfg(test)]
#[path = "experts_processor_tests.rs"]
mod tests;
