//! Crewon Apps support for the host-owned apps MCP server.
//!
//! This module owns the pieces that are unique to ChatGPT-hosted app
//! connectors: cache scoping by authenticated user, disk cache reads/writes,
//! connector allow-list filtering, and the normalization that turns app
//! connector/tool metadata into model-visible MCP callable names.

use std::path::PathBuf;
use std::time::Instant;

use crate::mcp::CREWON_APPS_MCP_SERVER_NAME;
use crate::runtime::emit_duration;
use crate::tools::MCP_TOOLS_CACHE_WRITE_DURATION_METRIC;
use crate::tools::ToolInfo;
use anyhow::Context;
use crewon_login::CrewonAuth;
use crewon_protocol::mcp::McpServerInfo;
use crewon_utils_plugins::mcp_connector::is_connector_id_allowed;
use crewon_utils_plugins::mcp_connector::sanitize_name;
use serde::Deserialize;
use serde::Serialize;
use sha1::Digest;
use sha1::Sha1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrewonAppsToolsCacheKey {
    pub(crate) account_id: Option<String>,
    pub(crate) chatgpt_user_id: Option<String>,
    pub(crate) is_workspace_account: bool,
}

pub fn crewon_apps_tools_cache_key(auth: Option<&CrewonAuth>) -> CrewonAppsToolsCacheKey {
    CrewonAppsToolsCacheKey {
        account_id: auth.and_then(CrewonAuth::get_account_id),
        chatgpt_user_id: auth.and_then(CrewonAuth::get_chatgpt_user_id),
        is_workspace_account: auth.is_some_and(CrewonAuth::is_workspace_account),
    }
}

#[derive(Clone)]
pub(crate) struct CrewonAppsToolsCacheContext {
    pub(crate) crewon_home: PathBuf,
    pub(crate) user_key: CrewonAppsToolsCacheKey,
}

impl CrewonAppsToolsCacheContext {
    pub(crate) fn tools_cache_path(&self) -> PathBuf {
        self.cache_path_in(CREWON_APPS_TOOLS_CACHE_DIR)
    }

    pub(crate) fn server_info_cache_path(&self) -> PathBuf {
        self.cache_path_in(CREWON_APPS_SERVER_INFO_CACHE_DIR)
    }

    pub(crate) fn legacy_tools_cache_path(&self) -> PathBuf {
        self.cache_path_in(LEGACY_CODEX_APPS_TOOLS_CACHE_DIR)
    }

    pub(crate) fn legacy_server_info_cache_path(&self) -> PathBuf {
        self.cache_path_in(LEGACY_CODEX_APPS_SERVER_INFO_CACHE_DIR)
    }

    fn cache_path_in(&self, cache_dir: &str) -> PathBuf {
        let user_key_json = serde_json::to_string(&self.user_key).unwrap_or_default();
        let user_key_hash = sha1_hex(&user_key_json);
        self.crewon_home
            .join(cache_dir)
            .join(format!("{user_key_hash}.json"))
    }
}

pub(crate) enum CachedCrewonAppsToolsLoad {
    Hit(Vec<ToolInfo>),
    Missing,
    Invalid,
}

pub(crate) fn normalize_crewon_apps_tool_title(
    server_name: &str,
    connector_name: Option<&str>,
    value: &str,
) -> String {
    if server_name != CREWON_APPS_MCP_SERVER_NAME {
        return value.to_string();
    }

    let Some(connector_name) = connector_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
    else {
        return value.to_string();
    };

    let prefix = format!("{connector_name}_");
    if let Some(stripped) = value.strip_prefix(&prefix)
        && !stripped.is_empty()
    {
        return stripped.to_string();
    }

    value.to_string()
}

pub(crate) fn normalize_crewon_apps_callable_name(
    server_name: &str,
    tool_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
) -> String {
    if server_name != CREWON_APPS_MCP_SERVER_NAME {
        return tool_name.to_string();
    }

    let tool_name = sanitize_name(tool_name);

    if let Some(connector_name) = connector_name
        .map(str::trim)
        .map(sanitize_name)
        .filter(|name| !name.is_empty())
        && let Some(stripped) = tool_name.strip_prefix(&connector_name)
        && !stripped.is_empty()
    {
        return stripped.to_string();
    }

    if let Some(connector_id) = connector_id
        .map(str::trim)
        .map(sanitize_name)
        .filter(|name| !name.is_empty())
        && let Some(stripped) = tool_name.strip_prefix(&connector_id)
        && !stripped.is_empty()
    {
        return stripped.to_string();
    }

    tool_name
}

pub(crate) fn normalize_crewon_apps_callable_namespace(
    server_name: &str,
    connector_name: Option<&str>,
) -> String {
    if server_name == CREWON_APPS_MCP_SERVER_NAME
        && let Some(connector_name) = connector_name
    {
        format!("{}__{}", server_name, sanitize_name(connector_name))
    } else {
        server_name.to_string()
    }
}

pub(crate) fn write_cached_crewon_apps_tools_if_needed(
    server_name: &str,
    cache_context: Option<&CrewonAppsToolsCacheContext>,
    server_info: &McpServerInfo,
    tools: &[ToolInfo],
) {
    if server_name != CREWON_APPS_MCP_SERVER_NAME {
        return;
    }

    if let Some(cache_context) = cache_context {
        let cache_write_start = Instant::now();
        write_cached_crewon_apps_tools(cache_context, tools);
        if let Err(err) = write_cached_crewon_apps_server_info(cache_context, server_info) {
            tracing::warn!("failed to write Crewon Apps server info cache: {err:#}");
        }
        emit_duration(
            MCP_TOOLS_CACHE_WRITE_DURATION_METRIC,
            cache_write_start.elapsed(),
            &[],
        );
    }
}

pub(crate) fn load_startup_cached_crewon_apps_tools_snapshot(
    server_name: &str,
    cache_context: Option<&CrewonAppsToolsCacheContext>,
) -> Option<Vec<ToolInfo>> {
    if server_name != CREWON_APPS_MCP_SERVER_NAME {
        return None;
    }

    let cache_context = cache_context?;

    match load_cached_crewon_apps_tools(cache_context) {
        CachedCrewonAppsToolsLoad::Hit(tools) => Some(tools),
        CachedCrewonAppsToolsLoad::Missing | CachedCrewonAppsToolsLoad::Invalid => None,
    }
}

pub(crate) fn load_startup_cached_crewon_apps_server_info(
    server_name: &str,
    cache_context: Option<&CrewonAppsToolsCacheContext>,
) -> Option<McpServerInfo> {
    if server_name != CREWON_APPS_MCP_SERVER_NAME {
        return None;
    }

    load_cached_crewon_apps_server_info(cache_context?)
}

#[cfg(test)]
pub(crate) fn read_cached_crewon_apps_tools(
    cache_context: &CrewonAppsToolsCacheContext,
) -> Option<Vec<ToolInfo>> {
    match load_cached_crewon_apps_tools(cache_context) {
        CachedCrewonAppsToolsLoad::Hit(tools) => Some(tools),
        CachedCrewonAppsToolsLoad::Missing | CachedCrewonAppsToolsLoad::Invalid => None,
    }
}

pub(crate) fn load_cached_crewon_apps_tools(
    cache_context: &CrewonAppsToolsCacheContext,
) -> CachedCrewonAppsToolsLoad {
    let bytes = match read_new_or_legacy(
        cache_context.tools_cache_path(),
        cache_context.legacy_tools_cache_path(),
    ) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return CachedCrewonAppsToolsLoad::Missing;
        }
        Err(_) => return CachedCrewonAppsToolsLoad::Invalid,
    };
    let cache: CrewonAppsToolsDiskCache = match serde_json::from_slice(&bytes) {
        Ok(cache) => cache,
        Err(_) => return CachedCrewonAppsToolsLoad::Invalid,
    };
    if cache.schema_version != CREWON_APPS_TOOLS_CACHE_SCHEMA_VERSION {
        return CachedCrewonAppsToolsLoad::Invalid;
    }
    CachedCrewonAppsToolsLoad::Hit(filter_disallowed_crewon_apps_tools(cache.tools))
}

pub(crate) fn write_cached_crewon_apps_tools(
    cache_context: &CrewonAppsToolsCacheContext,
    tools: &[ToolInfo],
) {
    let cache_path = cache_context.tools_cache_path();
    if let Some(parent) = cache_path.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return;
    }
    let tools = filter_disallowed_crewon_apps_tools(tools.to_vec());
    let Ok(bytes) = serde_json::to_vec_pretty(&CrewonAppsToolsDiskCache {
        schema_version: CREWON_APPS_TOOLS_CACHE_SCHEMA_VERSION,
        tools,
    }) else {
        return;
    };
    let _ = std::fs::write(cache_path, bytes);
}

pub(crate) fn load_cached_crewon_apps_server_info(
    cache_context: &CrewonAppsToolsCacheContext,
) -> Option<McpServerInfo> {
    let bytes = read_new_or_legacy(
        cache_context.server_info_cache_path(),
        cache_context.legacy_server_info_cache_path(),
    )
    .ok()?;
    let cache: CrewonAppsServerInfoDiskCache = serde_json::from_slice(&bytes).ok()?;
    (cache.schema_version == CREWON_APPS_SERVER_INFO_CACHE_SCHEMA_VERSION)
        .then_some(cache.server_info)
}

fn write_cached_crewon_apps_server_info(
    cache_context: &CrewonAppsToolsCacheContext,
    server_info: &McpServerInfo,
) -> anyhow::Result<()> {
    let cache_path = cache_context.server_info_cache_path();
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create Crewon Apps server info cache directory `{}`",
                parent.display()
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(&CrewonAppsServerInfoDiskCache {
        schema_version: CREWON_APPS_SERVER_INFO_CACHE_SCHEMA_VERSION,
        server_info: server_info.clone(),
    })
    .context("failed to serialize Crewon Apps server info cache")?;
    std::fs::write(&cache_path, bytes).with_context(|| {
        format!(
            "failed to write Crewon Apps server info cache `{}`",
            cache_path.display()
        )
    })?;
    Ok(())
}

pub(crate) fn filter_disallowed_crewon_apps_tools(tools: Vec<ToolInfo>) -> Vec<ToolInfo> {
    tools
        .into_iter()
        .filter(|tool| {
            tool.connector_id
                .as_deref()
                .is_none_or(is_connector_id_allowed)
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CrewonAppsToolsDiskCache {
    schema_version: u8,
    tools: Vec<ToolInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CrewonAppsServerInfoDiskCache {
    schema_version: u8,
    server_info: McpServerInfo,
}

const CREWON_APPS_TOOLS_CACHE_DIR: &str = "cache/crewon_apps_tools";
const LEGACY_CODEX_APPS_TOOLS_CACHE_DIR: &str = "cache/codex_apps_tools";
pub(crate) const CREWON_APPS_TOOLS_CACHE_SCHEMA_VERSION: u8 = 3;

const CREWON_APPS_SERVER_INFO_CACHE_DIR: &str = "cache/crewon_apps_server_info";
const LEGACY_CODEX_APPS_SERVER_INFO_CACHE_DIR: &str = "cache/codex_apps_server_info";
const CREWON_APPS_SERVER_INFO_CACHE_SCHEMA_VERSION: u8 = 1;

fn read_new_or_legacy(primary_path: PathBuf, legacy_path: PathBuf) -> std::io::Result<Vec<u8>> {
    match std::fs::read(&primary_path) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => std::fs::read(legacy_path),
        Err(err) => Err(err),
    }
}

fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    let sha1 = hasher.finalize();
    format!("{sha1:x}")
}
