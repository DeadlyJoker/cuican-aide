use std::io;
use std::path::Path;
use std::path::PathBuf;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::AgentListParams;
use crewon_app_server_protocol::AgentListResponse;
use crewon_app_server_protocol::AgentSaveParams;
use crewon_app_server_protocol::AgentSaveResponse;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::AutomationListResponse;
use crewon_app_server_protocol::AutomationSaveParams;
use crewon_app_server_protocol::AutomationSaveResponse;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeListParams;
use crewon_app_server_protocol::OfficeListResponse;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_app_server_protocol::OfficeSaveResponse;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio::fs;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const MAX_CONFIG_RECORDS: usize = 24;
const MAX_LIST_LIMIT: usize = 100;

#[derive(Clone, Copy)]
enum DomainKind {
    Agent,
    Office,
    Automation,
}

impl DomainKind {
    fn record_kind(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Office => "office",
            Self::Automation => "automation",
        }
    }

    fn directory_name(self) -> &'static str {
        match self {
            Self::Agent => "agents",
            Self::Office => "offices",
            Self::Automation => "automations",
        }
    }

    fn title_field(self) -> &'static str {
        match self {
            Self::Agent => "name",
            Self::Office | Self::Automation => "title",
        }
    }

    fn title(self, config: &JsonValue) -> Option<&str> {
        config.get(self.title_field()).and_then(JsonValue::as_str)
    }

    fn thread_id(self, config: &JsonValue) -> Option<&str> {
        match self {
            Self::Agent | Self::Automation => config.get("threadId").and_then(JsonValue::as_str),
            Self::Office => config
                .get("workspace")
                .and_then(|workspace| workspace.get("threadId"))
                .and_then(JsonValue::as_str),
        }
    }

    fn config_matches(self, config: &JsonValue) -> bool {
        let Some(config) = config.as_object() else {
            return false;
        };
        match self {
            Self::Agent => config.contains_key("name"),
            Self::Office => config
                .get("workspace")
                .is_some_and(serde_json::Value::is_object),
            Self::Automation => config.contains_key("title"),
        }
    }
}

#[derive(Default)]
pub(crate) struct CrewonDomainRequestProcessor;

impl CrewonDomainRequestProcessor {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) async fn agent_list(
        &self,
        params: AgentListParams,
    ) -> Result<AgentListResponse, JSONRPCErrorError> {
        list_records(DomainKind::Agent, &params.cwd, params.cursor, params.limit)
            .await
            .map(|(data, next_cursor)| AgentListResponse { data, next_cursor })
    }

    pub(crate) async fn agent_save(
        &self,
        params: AgentSaveParams,
    ) -> Result<AgentSaveResponse, JSONRPCErrorError> {
        save_record(DomainKind::Agent, &params.cwd, params.config)
            .await
            .map(|file_path| AgentSaveResponse { file_path })
    }

    pub(crate) async fn office_list(
        &self,
        params: OfficeListParams,
    ) -> Result<OfficeListResponse, JSONRPCErrorError> {
        list_records(DomainKind::Office, &params.cwd, params.cursor, params.limit)
            .await
            .map(|(data, next_cursor)| OfficeListResponse { data, next_cursor })
    }

    pub(crate) async fn office_save(
        &self,
        params: OfficeSaveParams,
    ) -> Result<OfficeSaveResponse, JSONRPCErrorError> {
        save_record(DomainKind::Office, &params.cwd, params.config)
            .await
            .map(|file_path| OfficeSaveResponse { file_path })
    }

    pub(crate) async fn automation_list(
        &self,
        params: AutomationListParams,
    ) -> Result<AutomationListResponse, JSONRPCErrorError> {
        list_records(
            DomainKind::Automation,
            &params.cwd,
            params.cursor,
            params.limit,
        )
        .await
        .map(|(data, next_cursor)| AutomationListResponse { data, next_cursor })
    }

    pub(crate) async fn automation_save(
        &self,
        params: AutomationSaveParams,
    ) -> Result<AutomationSaveResponse, JSONRPCErrorError> {
        save_record(DomainKind::Automation, &params.cwd, params.config)
            .await
            .map(|file_path| AutomationSaveResponse { file_path })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDomainConfigRecord {
    version: u32,
    kind: String,
    saved_at: Option<String>,
    config: JsonValue,
}

async fn list_records(
    kind: DomainKind,
    cwd: &str,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonDomainConfigRecord>, Option<String>), JSONRPCErrorError> {
    let offset = parse_cursor(cursor)?;
    let limit = normalize_limit(limit);
    let directory = domain_directory(cwd, kind)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), None)),
        Err(err) => {
            return Err(internal_error(format!(
                "failed to read {}: {err}",
                directory.display()
            )));
        }
    };

    let mut records = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let Some(record) = read_record(kind, &path).await? else {
            continue;
        };
        records.push(record);
    }

    records.sort_by(|left, right| right.saved_at.cmp(&left.saved_at));
    let next_cursor = if records.len() > offset + limit {
        Some((offset + limit).to_string())
    } else {
        None
    };
    let records = records.into_iter().skip(offset).take(limit).collect();
    Ok((records, next_cursor))
}

async fn read_record(
    kind: DomainKind,
    path: &Path,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let record = match serde_json::from_slice::<PersistedDomainConfigRecord>(&bytes) {
        Ok(record) => record,
        Err(_) => return Ok(None),
    };
    if record.version != 1
        || record.kind != kind.record_kind()
        || !kind.config_matches(&record.config)
    {
        return Ok(None);
    }

    Ok(Some(CrewonDomainConfigRecord {
        file_path: path.to_string_lossy().into_owned(),
        saved_at: record.saved_at.unwrap_or_default(),
        config: record.config,
    }))
}

async fn save_record(
    kind: DomainKind,
    cwd: &str,
    config: JsonValue,
) -> Result<String, JSONRPCErrorError> {
    if !kind.config_matches(&config) {
        return Err(invalid_params(format!(
            "{} config is missing required fields",
            kind.record_kind()
        )));
    }

    let directory = domain_directory(cwd, kind)?;
    fs::create_dir_all(&directory).await.map_err(map_io_error)?;

    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let file_path = directory.join(domain_file_name(kind, &config));
    let record = PersistedDomainConfigRecord {
        version: 1,
        kind: kind.record_kind().to_string(),
        saved_at: Some(saved_at),
        config,
    };

    let mut bytes = serde_json::to_vec_pretty(&record)
        .map_err(|err| internal_error(format!("failed to serialize domain config: {err}")))?;
    bytes.push(b'\n');
    fs::write(&file_path, bytes).await.map_err(map_io_error)?;
    Ok(file_path.to_string_lossy().into_owned())
}

fn domain_directory(cwd: &str, kind: DomainKind) -> Result<PathBuf, JSONRPCErrorError> {
    if cwd.trim().is_empty() {
        return Err(invalid_params("cwd must not be empty"));
    }

    let cwd = PathBuf::from(cwd);
    if !cwd.is_absolute() {
        return Err(invalid_params("cwd must be an absolute path"));
    }

    Ok(cwd.join(".crewon").join(kind.directory_name()))
}

fn normalize_limit(limit: Option<u32>) -> usize {
    limit
        .and_then(|limit| usize::try_from(limit).ok())
        .filter(|limit| *limit > 0)
        .map(|limit| limit.min(MAX_LIST_LIMIT))
        .unwrap_or(MAX_CONFIG_RECORDS)
}

fn parse_cursor(cursor: Option<String>) -> Result<usize, JSONRPCErrorError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .parse::<usize>()
        .map_err(|err| invalid_params(format!("invalid cursor: {err}")))
}

fn domain_file_name(kind: DomainKind, config: &JsonValue) -> String {
    let title = kind.title(config).unwrap_or_else(|| kind.record_kind());
    let suffix = kind
        .thread_id(config)
        .map(|thread_id| thread_id.chars().take(8).collect::<String>())
        .filter(|thread_id| !thread_id.is_empty())
        .unwrap_or_else(|| Utc::now().timestamp_millis().to_string());
    let stem = slugify(title, kind.record_kind());
    let suffix = slugify(&suffix, &suffix);
    format!("{stem}-{suffix}.json")
}

fn slugify(value: &str, fallback: &str) -> String {
    let mut slug = String::new();
    let mut needs_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            if needs_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(ch);
            needs_dash = false;
        } else {
            needs_dash = true;
        }
    }

    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

fn map_io_error(err: io::Error) -> JSONRPCErrorError {
    internal_error(err.to_string())
}

#[cfg(test)]
#[path = "crewon_domain_processor_tests.rs"]
mod tests;
