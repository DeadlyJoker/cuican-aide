use super::crewon_domain_processor::read_agent_record;
use super::crewon_domain_processor::read_agent_record_by_file_path;
use super::crewon_domain_processor::read_office_record;
use super::crewon_domain_processor::read_office_record_by_file_path;
use super::invalid_request;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::SceneExecutionTargetSelection;
use crewon_app_server_protocol::ThreadSceneSelectionParams;
use crewon_protocol::scene::SceneExecutionStrategy;
use crewon_protocol::scene::SceneExecutionTargetKind;
use crewon_protocol::scene::SceneExecutionTargetProfile;
use crewon_protocol::scene::SceneTeamMemberProfile;
use crewon_protocol::scene::SceneThreadMetadata;
use crewon_scene_runtime::ExecutionStrategy;
use crewon_scene_runtime::ExecutionTargetCatalogRecord;
use crewon_scene_runtime::ExecutionTargetKind;
use crewon_scene_runtime::ExecutionTargetResolver;
use crewon_scene_runtime::ExecutionTargetSelection;
use crewon_scene_runtime::TargetAuthorization;
use crewon_scene_runtime::TargetAvailability;
use crewon_scene_runtime::TargetRuntimeAvailability;
use sha2::Digest;
use sha2::Sha256;

const SCENE_RUNTIME_VERSION: u16 = 1;
const MAX_TARGET_ID_LENGTH: usize = 512;

pub(super) async fn resolve_thread_scene(
    cwd: &str,
    selection: ThreadSceneSelectionParams,
) -> Result<SceneThreadMetadata, JSONRPCErrorError> {
    let scene = selection.scene_id.into();
    let preset = crewon_scene_runtime::scene_preset(scene);
    let mode = selection
        .mode
        .map(Into::into)
        .unwrap_or(preset.default_mode);
    let contract = crewon_scene_runtime::resolve_scene_contract(
        scene,
        mode,
        selection.deliverable.map(Into::into),
    )
    .map_err(|err| invalid_request(err.to_string()))?;
    let target_selection = selection
        .execution_target
        .unwrap_or(SceneExecutionTargetSelection::Crewon);
    let (runtime_selection, target_ref, catalog) =
        resolve_target_catalog(cwd, target_selection).await?;
    let crewon_token = opaque_target_token(cwd, "crewon", "default");
    let resolved = ExecutionTargetResolver::new(crewon_token, TargetRuntimeAvailability::Ready)
        .map_err(|err| invalid_request(err.to_string()))?
        .resolve(&runtime_selection, &catalog)
        .map_err(|err| invalid_request(err.to_string()))?;
    if resolved.availability != TargetAvailability::Ready {
        return Err(invalid_request(format!(
            "execution target is not ready: {:?}",
            resolved.availability
        )));
    }

    Ok(SceneThreadMetadata {
        version: SCENE_RUNTIME_VERSION,
        preset_version: preset.preset_version,
        instruction_version: preset.instruction_version,
        contract,
        execution_target_kind: match resolved.kind {
            ExecutionTargetKind::Crewon => SceneExecutionTargetKind::Crewon,
            ExecutionTargetKind::Agent => SceneExecutionTargetKind::Agent,
            ExecutionTargetKind::Team => SceneExecutionTargetKind::Team,
        },
        execution_target_ref: target_ref,
        execution_target_token: resolved.token,
        execution_strategy: match resolved.execution_strategy {
            ExecutionStrategy::Single => SceneExecutionStrategy::Single,
            ExecutionStrategy::Team => SceneExecutionStrategy::Team,
        },
    })
}

pub(super) async fn revalidate_thread_scene(
    cwd: &str,
    mut metadata: SceneThreadMetadata,
) -> Result<SceneThreadMetadata, JSONRPCErrorError> {
    if metadata.version != SCENE_RUNTIME_VERSION {
        return Err(invalid_request(format!(
            "unsupported scene runtime version: {}",
            metadata.version
        )));
    }

    let (kind, target_ref) = match metadata.execution_target_kind {
        SceneExecutionTargetKind::Crewon => {
            if metadata.execution_strategy != SceneExecutionStrategy::Single
                || metadata.execution_target_ref.is_some()
            {
                return Err(invalid_request("invalid persisted CrewON execution target"));
            }
            ("crewon", "default")
        }
        SceneExecutionTargetKind::Agent => {
            if metadata.execution_strategy != SceneExecutionStrategy::Single {
                return Err(invalid_request(
                    "invalid persisted Agent execution strategy",
                ));
            }
            let target_ref = metadata.execution_target_ref.as_deref().ok_or_else(|| {
                invalid_request("persisted Agent target is missing its reference")
            })?;
            if read_agent_record_by_file_path(cwd, target_ref)
                .await?
                .is_none()
            {
                return Err(invalid_request(
                    "persisted Agent execution target is unavailable",
                ));
            }
            ("agent", target_ref)
        }
        SceneExecutionTargetKind::Team => {
            if metadata.execution_strategy != SceneExecutionStrategy::Team {
                return Err(invalid_request("invalid persisted Team execution strategy"));
            }
            let target_ref = metadata
                .execution_target_ref
                .as_deref()
                .ok_or_else(|| invalid_request("persisted Team target is missing its reference"))?;
            let record = read_office_record_by_file_path(cwd, target_ref)
                .await?
                .ok_or_else(|| invalid_request("persisted Team execution target is unavailable"))?;
            if !office_has_members(&record.config) {
                return Err(invalid_request(
                    "persisted Team execution target has no members",
                ));
            }
            ("team", target_ref)
        }
    };

    metadata.execution_target_token = opaque_target_token(cwd, kind, target_ref);
    Ok(metadata)
}

pub(super) async fn resolve_execution_target_profile(
    cwd: &str,
    metadata: &SceneThreadMetadata,
) -> Result<Option<SceneExecutionTargetProfile>, JSONRPCErrorError> {
    let Some(target_ref) = metadata.execution_target_ref.as_deref() else {
        return Ok(None);
    };
    match metadata.execution_target_kind {
        SceneExecutionTargetKind::Crewon => Ok(None),
        SceneExecutionTargetKind::Agent => {
            let record = read_agent_record_by_file_path(cwd, target_ref)
                .await?
                .ok_or_else(|| {
                    invalid_request("persisted Agent execution target is unavailable")
                })?;
            let config = &record.config;
            Ok(Some(SceneExecutionTargetProfile {
                kind: SceneExecutionTargetKind::Agent,
                display_name: bounded_config_string(config, "name", 128)
                    .unwrap_or_else(|| "Agent".to_string()),
                role: bounded_config_string(config, "role", 512),
                model: bounded_config_string(config, "model", 256),
                instructions: bounded_config_string(config, "systemPrompt", 4_000),
                capabilities: configured_capability_names(config),
                team_members: Vec::new(),
            }))
        }
        SceneExecutionTargetKind::Team => {
            let record = read_office_record_by_file_path(cwd, target_ref)
                .await?
                .ok_or_else(|| invalid_request("persisted Team execution target is unavailable"))?;
            let config = &record.config;
            let workspace = config.get("workspace");
            let members = workspace
                .and_then(|workspace| workspace.get("members"))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .take(12)
                .map(|member| SceneTeamMemberProfile {
                    name: bounded_config_string(member, "name", 96)
                        .unwrap_or_else(|| "Team member".to_string()),
                    role: bounded_config_string(member, "role", 160),
                    agent_id: bounded_config_string(member, "agentId", 128),
                })
                .collect();
            Ok(Some(SceneExecutionTargetProfile {
                kind: SceneExecutionTargetKind::Team,
                display_name: bounded_config_string(config, "title", 128)
                    .unwrap_or_else(|| "Team".to_string()),
                role: workspace.and_then(|workspace| bounded_config_string(workspace, "goal", 512)),
                model: None,
                instructions: None,
                capabilities: Vec::new(),
                team_members: members,
            }))
        }
    }
}

pub(super) async fn hydrate_thread_scene_config(
    cwd: &str,
    metadata: SceneThreadMetadata,
    config: &mut crewon_core::config::Config,
) -> Result<(), JSONRPCErrorError> {
    let profile = resolve_execution_target_profile(cwd, &metadata).await?;
    if let Some(model) = profile.as_ref().and_then(|profile| profile.model.clone()) {
        config.model = Some(model);
    }
    let extra = config.extra_config.get_or_insert_with(Default::default);
    extra.scene_runtime = Some(metadata);
    extra.scene_execution_target_profile = profile;
    Ok(())
}

async fn resolve_target_catalog(
    cwd: &str,
    selection: SceneExecutionTargetSelection,
) -> Result<
    (
        ExecutionTargetSelection,
        Option<String>,
        Vec<ExecutionTargetCatalogRecord>,
    ),
    JSONRPCErrorError,
> {
    match selection {
        SceneExecutionTargetSelection::Crewon => {
            Ok((ExecutionTargetSelection::Crewon, None, Vec::new()))
        }
        SceneExecutionTargetSelection::Agent { id } => {
            validate_target_id(&id)?;
            let record = read_agent_record(cwd, Some(&id), None, None)
                .await?
                .ok_or_else(|| {
                    invalid_request(format!("agent execution target not found: {id}"))
                })?;
            let target_ref = record.file_path;
            let token = opaque_target_token(cwd, "agent", &target_ref);
            Ok((
                ExecutionTargetSelection::Agent { id: id.clone() },
                Some(target_ref),
                vec![ExecutionTargetCatalogRecord {
                    kind: ExecutionTargetKind::Agent,
                    id,
                    token,
                    authorization: TargetAuthorization::Authorized,
                    runtime_availability: TargetRuntimeAvailability::Ready,
                }],
            ))
        }
        SceneExecutionTargetSelection::Team { id } => {
            validate_target_id(&id)?;
            let record = read_office_record(cwd, None, Some(&id))
                .await?
                .ok_or_else(|| invalid_request(format!("team execution target not found: {id}")))?;
            if !office_has_members(&record.config) {
                return Err(invalid_request(format!(
                    "team execution target has no members: {id}"
                )));
            }
            let target_ref = record.file_path;
            let token = opaque_target_token(cwd, "team", &target_ref);
            Ok((
                ExecutionTargetSelection::Team { id: id.clone() },
                Some(target_ref),
                vec![ExecutionTargetCatalogRecord {
                    kind: ExecutionTargetKind::Team,
                    id,
                    token,
                    authorization: TargetAuthorization::Authorized,
                    runtime_availability: TargetRuntimeAvailability::Ready,
                }],
            ))
        }
    }
}

fn office_has_members(config: &serde_json::Value) -> bool {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|members| !members.is_empty())
}

fn configured_capability_names(config: &serde_json::Value) -> Vec<String> {
    ["skills", "mcp"]
        .into_iter()
        .flat_map(|field| {
            config
                .get(field)
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|capability| {
                    capability
                        .get("enabled")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                })
                .filter_map(|capability| {
                    ["name", "title", "id"]
                        .into_iter()
                        .find_map(|field| bounded_config_string(capability, field, 96))
                })
        })
        .take(16)
        .collect()
}

fn bounded_config_string(
    config: &serde_json::Value,
    field: &str,
    max_chars: usize,
) -> Option<String> {
    let value = config.get(field)?.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(max_chars).collect())
}

fn validate_target_id(id: &str) -> Result<(), JSONRPCErrorError> {
    if id.trim().is_empty() || id.len() > MAX_TARGET_ID_LENGTH {
        return Err(invalid_request(
            "execution target id must be between 1 and 512 characters",
        ));
    }
    Ok(())
}

fn opaque_target_token(cwd: &str, kind: &str, target_ref: &str) -> String {
    let digest = Sha256::digest(format!(
        "crewon.scene.target.v1\0{cwd}\0{kind}\0{target_ref}"
    ));
    format!("tgt_{digest:x}")
}

#[cfg(test)]
#[path = "scene_runtime_tests.rs"]
mod tests;
