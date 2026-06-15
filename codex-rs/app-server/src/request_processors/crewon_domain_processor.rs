use std::io;
use std::path::Path;
use std::path::PathBuf;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::AgentDeleteParams;
use crewon_app_server_protocol::AgentDeleteResponse;
use crewon_app_server_protocol::AgentListParams;
use crewon_app_server_protocol::AgentListResponse;
use crewon_app_server_protocol::AgentReadParams;
use crewon_app_server_protocol::AgentReadResponse;
use crewon_app_server_protocol::AgentSaveParams;
use crewon_app_server_protocol::AgentSaveResponse;
use crewon_app_server_protocol::AutomationDeleteParams;
use crewon_app_server_protocol::AutomationDeleteResponse;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::AutomationListResponse;
use crewon_app_server_protocol::AutomationRunParams;
use crewon_app_server_protocol::AutomationRunRecord;
use crewon_app_server_protocol::AutomationRunResponse;
use crewon_app_server_protocol::AutomationRunUpdateParams;
use crewon_app_server_protocol::AutomationRunUpdateResponse;
use crewon_app_server_protocol::AutomationRunsListParams;
use crewon_app_server_protocol::AutomationRunsListResponse;
use crewon_app_server_protocol::AutomationSaveParams;
use crewon_app_server_protocol::AutomationSaveResponse;
use crewon_app_server_protocol::CrewonAutomationRunConfigRecord;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::CrewonToolConfigRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeDeleteParams;
use crewon_app_server_protocol::OfficeDeleteResponse;
use crewon_app_server_protocol::OfficeListParams;
use crewon_app_server_protocol::OfficeListResponse;
use crewon_app_server_protocol::OfficeMemberAddParams;
use crewon_app_server_protocol::OfficeMemberAddResponse;
use crewon_app_server_protocol::OfficeMessageSendParams;
use crewon_app_server_protocol::OfficeMessageSendResponse;
use crewon_app_server_protocol::OfficeReadParams;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_app_server_protocol::OfficeSaveResponse;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolDeleteParams;
use crewon_app_server_protocol::ToolDeleteResponse;
use crewon_app_server_protocol::ToolListParams;
use crewon_app_server_protocol::ToolListResponse;
use crewon_app_server_protocol::ToolSaveParams;
use crewon_app_server_protocol::ToolSaveResponse;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::cmp::Reverse;
use tokio::fs;
use uuid::Uuid;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const MAX_CONFIG_RECORDS: usize = 24;
const MAX_LIST_LIMIT: usize = 100;
const AUTOMATION_RUNS_DIRECTORY: &str = "automation-runs";

#[derive(Clone, Copy)]
enum DomainKind {
    Agent,
    Office,
    Automation,
    Tool,
}

impl DomainKind {
    fn record_kind(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Office => "office",
            Self::Automation => "automation",
            Self::Tool => "tool",
        }
    }

    fn directory_name(self) -> &'static str {
        match self {
            Self::Agent => "agents",
            Self::Office => "offices",
            Self::Automation => "automations",
            Self::Tool => "tools",
        }
    }

    fn title_field(self) -> &'static str {
        match self {
            Self::Agent => "name",
            Self::Office | Self::Automation | Self::Tool => "title",
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
            Self::Tool => tool_identity(config),
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
            Self::Tool => {
                matches!(
                    config.get("kind").and_then(JsonValue::as_str),
                    Some("mcp" | "skill")
                ) && config.contains_key("title")
            }
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
        let (config, agent_id) = ensure_agent_id(params.config)?;
        save_record(DomainKind::Agent, &params.cwd, config)
            .await
            .map(|file_path| AgentSaveResponse {
                file_path,
                agent_id,
            })
    }

    pub(crate) async fn agent_read(
        &self,
        params: AgentReadParams,
    ) -> Result<AgentReadResponse, JSONRPCErrorError> {
        read_agent_record(
            &params.cwd,
            params.agent_id.as_deref(),
            params.thread_id.as_deref(),
            params.name.as_deref(),
        )
        .await
        .map(|record| AgentReadResponse { record })
    }

    pub(crate) async fn agent_delete(
        &self,
        params: AgentDeleteParams,
    ) -> Result<AgentDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Agent, &params.cwd, &params.file_path)
            .await
            .map(|deleted| AgentDeleteResponse { deleted })
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

    pub(crate) async fn office_read(
        &self,
        params: OfficeReadParams,
    ) -> Result<OfficeReadResponse, JSONRPCErrorError> {
        read_office_record(
            &params.cwd,
            params.thread_id.as_deref(),
            params.title.as_deref(),
        )
        .await
        .map(|record| OfficeReadResponse { record })
    }

    pub(crate) async fn office_message_send(
        &self,
        params: OfficeMessageSendParams,
    ) -> Result<OfficeMessageSendResponse, JSONRPCErrorError> {
        let config = append_office_message(params.config, params.message)?;
        save_record(DomainKind::Office, &params.cwd, config.clone())
            .await
            .map(|file_path| OfficeMessageSendResponse { file_path, config })
    }

    pub(crate) async fn office_member_add(
        &self,
        params: OfficeMemberAddParams,
    ) -> Result<OfficeMemberAddResponse, JSONRPCErrorError> {
        let config = append_office_member(params.config, &params.agent_id, params.member)?;
        save_record(DomainKind::Office, &params.cwd, config.clone())
            .await
            .map(|file_path| OfficeMemberAddResponse { file_path, config })
    }

    pub(crate) async fn office_delete(
        &self,
        params: OfficeDeleteParams,
    ) -> Result<OfficeDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Office, &params.cwd, &params.file_path)
            .await
            .map(|deleted| OfficeDeleteResponse { deleted })
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

    pub(crate) async fn automation_run(
        &self,
        params: AutomationRunParams,
    ) -> Result<AutomationRunResponse, JSONRPCErrorError> {
        create_automation_run(&params.cwd, params.config, params.note, params.turn_id).await
    }

    pub(crate) async fn automation_run_update(
        &self,
        params: AutomationRunUpdateParams,
    ) -> Result<AutomationRunUpdateResponse, JSONRPCErrorError> {
        update_automation_run(
            &params.cwd,
            &params.file_path,
            params.status,
            params.completed_at,
        )
        .await
    }

    pub(crate) async fn automation_runs_list(
        &self,
        params: AutomationRunsListParams,
    ) -> Result<AutomationRunsListResponse, JSONRPCErrorError> {
        list_automation_runs(
            &params.cwd,
            params.thread_id.as_deref(),
            params.cursor,
            params.limit,
        )
        .await
        .map(|(data, next_cursor)| AutomationRunsListResponse { data, next_cursor })
    }

    pub(crate) async fn automation_delete(
        &self,
        params: AutomationDeleteParams,
    ) -> Result<AutomationDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Automation, &params.cwd, &params.file_path)
            .await
            .map(|deleted| AutomationDeleteResponse { deleted })
    }

    pub(crate) async fn tool_list(
        &self,
        params: ToolListParams,
    ) -> Result<ToolListResponse, JSONRPCErrorError> {
        let (records, next_cursor) =
            list_tool_records(&params.cwd, params.kind, params.cursor, params.limit).await?;
        Ok(ToolListResponse {
            data: records,
            next_cursor,
        })
    }

    pub(crate) async fn tool_save(
        &self,
        params: ToolSaveParams,
    ) -> Result<ToolSaveResponse, JSONRPCErrorError> {
        save_record(DomainKind::Tool, &params.cwd, params.config)
            .await
            .map(|file_path| ToolSaveResponse { file_path })
    }

    pub(crate) async fn tool_delete(
        &self,
        params: ToolDeleteParams,
    ) -> Result<ToolDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Tool, &params.cwd, &params.file_path)
            .await
            .map(|deleted| ToolDeleteResponse { deleted })
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAutomationRunRecord {
    version: u32,
    saved_at: Option<i64>,
    run: AutomationRunRecord,
}

async fn list_records(
    kind: DomainKind,
    cwd: &str,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonDomainConfigRecord>, Option<String>), JSONRPCErrorError> {
    list_records_matching(kind, cwd, cursor, limit, |_| true).await
}

async fn list_records_matching(
    kind: DomainKind,
    cwd: &str,
    cursor: Option<String>,
    limit: Option<u32>,
    mut include_record: impl FnMut(&CrewonDomainConfigRecord) -> bool,
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
        if !include_record(&record) {
            continue;
        }
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

async fn list_tool_records(
    cwd: &str,
    kind_filter: Option<ToolConfigKind>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonToolConfigRecord>, Option<String>), JSONRPCErrorError> {
    let (records, next_cursor) =
        list_records_matching(DomainKind::Tool, cwd, cursor, limit, |record| {
            let Some(kind) = tool_kind(&record.config) else {
                return false;
            };
            match kind_filter {
                Some(kind_filter) => kind_filter == kind,
                None => true,
            }
        })
        .await?;
    let records = records
        .into_iter()
        .filter_map(|record| {
            let kind = tool_kind(&record.config)?;
            if kind_filter.is_some_and(|kind_filter| kind_filter != kind) {
                return None;
            }
            Some(CrewonToolConfigRecord {
                file_path: record.file_path,
                saved_at: record.saved_at,
                kind,
                config: record.config,
            })
        })
        .collect();
    Ok((records, next_cursor))
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

async fn create_automation_run(
    cwd: &str,
    config: JsonValue,
    note: Option<String>,
    turn_id: Option<String>,
) -> Result<AutomationRunResponse, JSONRPCErrorError> {
    if !DomainKind::Automation.config_matches(&config) {
        return Err(invalid_params(
            "automation config is missing required fields",
        ));
    }

    let directory = automation_runs_directory(cwd)?;
    fs::create_dir_all(&directory).await.map_err(map_io_error)?;
    let now = Utc::now();
    let started_at = now.timestamp();
    let title = config
        .get("title")
        .and_then(JsonValue::as_str)
        .unwrap_or("automation")
        .to_string();
    let thread_id = config
        .get("threadId")
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let run_id = format!("run-{}", Uuid::now_v7());
    let run = AutomationRunRecord {
        run_id: run_id.clone(),
        automation_title: title.clone(),
        thread_id,
        turn_id,
        status: "running".to_string(),
        started_at,
        completed_at: None,
        note,
        config,
    };
    let file_path = directory.join(format!(
        "{}-{}.json",
        slugify(&title, "automation"),
        slugify(&run_id, &run_id)
    ));
    let record = PersistedAutomationRunRecord {
        version: 1,
        saved_at: Some(started_at),
        run: run.clone(),
    };
    let mut bytes = serde_json::to_vec_pretty(&record)
        .map_err(|err| internal_error(format!("failed to serialize automation run: {err}")))?;
    bytes.push(b'\n');
    fs::write(&file_path, bytes).await.map_err(map_io_error)?;
    Ok(AutomationRunResponse {
        file_path: file_path.to_string_lossy().into_owned(),
        run,
    })
}

async fn update_automation_run(
    cwd: &str,
    file_path: &str,
    status: String,
    completed_at: Option<i64>,
) -> Result<AutomationRunUpdateResponse, JSONRPCErrorError> {
    if status.trim().is_empty() {
        return Err(invalid_params("status must not be empty"));
    }
    let file_path = validate_automation_run_file_path(cwd, file_path)?;
    let Some(mut record) = read_persisted_automation_run_record(&file_path).await? else {
        return Err(invalid_params("automation run file was not found"));
    };
    record.run.status = status;
    record.run.completed_at = completed_at;
    let run = record.run.clone();
    write_automation_run_record(&file_path, &record).await?;
    Ok(AutomationRunUpdateResponse {
        file_path: file_path.to_string_lossy().into_owned(),
        run,
    })
}

async fn list_automation_runs(
    cwd: &str,
    thread_id: Option<&str>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonAutomationRunConfigRecord>, Option<String>), JSONRPCErrorError> {
    let offset = parse_cursor(cursor)?;
    let limit = normalize_limit(limit);
    let directory = automation_runs_directory(cwd)?;
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
        let Some(record) = read_automation_run_config_record(&path).await? else {
            continue;
        };
        if thread_id.is_some_and(|thread_id| record.run.thread_id.as_deref() != Some(thread_id)) {
            continue;
        }
        records.push(record);
    }

    records.sort_by_key(|record| Reverse(record.saved_at));
    let next_cursor = if records.len() > offset + limit {
        Some((offset + limit).to_string())
    } else {
        None
    };
    let records = records.into_iter().skip(offset).take(limit).collect();
    Ok((records, next_cursor))
}

async fn read_automation_run_config_record(
    path: &Path,
) -> Result<Option<CrewonAutomationRunConfigRecord>, JSONRPCErrorError> {
    let Some(record) = read_persisted_automation_run_record(path).await? else {
        return Ok(None);
    };
    Ok(Some(CrewonAutomationRunConfigRecord {
        file_path: path.to_string_lossy().into_owned(),
        saved_at: record.saved_at.unwrap_or_default(),
        run: record.run,
    }))
}

async fn read_persisted_automation_run_record(
    path: &Path,
) -> Result<Option<PersistedAutomationRunRecord>, JSONRPCErrorError> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(map_io_error(err)),
    };
    let record = match serde_json::from_slice::<PersistedAutomationRunRecord>(&bytes) {
        Ok(record) => record,
        Err(_) => return Ok(None),
    };
    if record.version != 1 {
        return Ok(None);
    }
    Ok(Some(record))
}

async fn write_automation_run_record(
    file_path: &Path,
    record: &PersistedAutomationRunRecord,
) -> Result<(), JSONRPCErrorError> {
    let mut bytes = serde_json::to_vec_pretty(record)
        .map_err(|err| internal_error(format!("failed to serialize automation run: {err}")))?;
    bytes.push(b'\n');
    fs::write(file_path, bytes).await.map_err(map_io_error)
}

fn ensure_agent_id(mut config: JsonValue) -> Result<(JsonValue, String), JSONRPCErrorError> {
    if !DomainKind::Agent.config_matches(&config) {
        return Err(invalid_params("agent config is missing required fields"));
    }
    let agent_id = config
        .get("agentId")
        .and_then(JsonValue::as_str)
        .filter(|agent_id| !agent_id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let title = DomainKind::Agent.title(&config).unwrap_or("agent");
            format!("agent-{}", slugify(title, "agent"))
        });
    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("agent config must be an object"));
    };
    config_object.insert("agentId".to_string(), JsonValue::String(agent_id.clone()));
    Ok((config, agent_id))
}

async fn read_office_record(
    cwd: &str,
    thread_id: Option<&str>,
    title: Option<&str>,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if thread_id.is_none() && title.is_none() {
        return Err(invalid_params("threadId or title is required"));
    }
    let (records, _) =
        list_records(DomainKind::Office, cwd, None, Some(MAX_LIST_LIMIT as u32)).await?;
    Ok(records.into_iter().find(|record| {
        thread_id.is_some_and(|thread_id| office_thread_id(&record.config) == Some(thread_id))
            || title.is_some_and(|title| {
                record.config.get("title").and_then(JsonValue::as_str) == Some(title)
            })
    }))
}

async fn read_agent_record(
    cwd: &str,
    agent_id: Option<&str>,
    thread_id: Option<&str>,
    name: Option<&str>,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if agent_id.is_none() && thread_id.is_none() && name.is_none() {
        return Err(invalid_params("agentId, threadId, or name is required"));
    }
    let (records, _) =
        list_records(DomainKind::Agent, cwd, None, Some(MAX_LIST_LIMIT as u32)).await?;
    Ok(records.into_iter().find(|record| {
        agent_id.is_some_and(|agent_id| {
            record.config.get("agentId").and_then(JsonValue::as_str) == Some(agent_id)
        }) || thread_id.is_some_and(|thread_id| {
            record.config.get("threadId").and_then(JsonValue::as_str) == Some(thread_id)
        }) || name
            .is_some_and(|name| record.config.get("name").and_then(JsonValue::as_str) == Some(name))
    }))
}

fn append_office_message(
    mut config: JsonValue,
    message: JsonValue,
) -> Result<JsonValue, JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    if !message.is_object() {
        return Err(invalid_params("message must be an object"));
    }

    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("office config is missing workspace"));
    };
    let messages = workspace
        .entry("messages")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    let Some(messages) = messages.as_array_mut() else {
        return Err(invalid_params("workspace.messages must be an array"));
    };
    messages.push(message);
    Ok(config)
}

fn append_office_member(
    mut config: JsonValue,
    agent_id: &str,
    mut member: JsonValue,
) -> Result<JsonValue, JSONRPCErrorError> {
    if agent_id.trim().is_empty() {
        return Err(invalid_params("agentId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    let Some(member_object) = member.as_object_mut() else {
        return Err(invalid_params("member must be an object"));
    };
    member_object.insert(
        "agentId".to_string(),
        JsonValue::String(agent_id.trim().to_string()),
    );

    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("office config is missing workspace"));
    };
    let members = workspace
        .entry("members")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    let Some(members) = members.as_array_mut() else {
        return Err(invalid_params("workspace.members must be an array"));
    };
    members
        .retain(|existing| existing.get("agentId").and_then(JsonValue::as_str) != Some(agent_id));
    members.push(member);
    Ok(config)
}

fn office_thread_id(config: &JsonValue) -> Option<&str> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("threadId"))
        .and_then(JsonValue::as_str)
}

async fn delete_record(
    kind: DomainKind,
    cwd: &str,
    file_path: &str,
) -> Result<bool, JSONRPCErrorError> {
    let file_path = validate_record_file_path(cwd, kind, file_path)?;
    if !fs::try_exists(&file_path).await.map_err(map_io_error)? {
        return Ok(false);
    }

    match read_record(kind, &file_path).await? {
        Some(_) => {
            fs::remove_file(file_path).await.map_err(map_io_error)?;
            Ok(true)
        }
        None => Err(invalid_params(format!(
            "{} config file does not match the requested kind",
            kind.record_kind()
        ))),
    }
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

fn automation_runs_directory(cwd: &str) -> Result<PathBuf, JSONRPCErrorError> {
    if cwd.trim().is_empty() {
        return Err(invalid_params("cwd must not be empty"));
    }

    let cwd = PathBuf::from(cwd);
    if !cwd.is_absolute() {
        return Err(invalid_params("cwd must be an absolute path"));
    }

    Ok(cwd.join(".crewon").join(AUTOMATION_RUNS_DIRECTORY))
}

fn validate_automation_run_file_path(
    cwd: &str,
    file_path: &str,
) -> Result<PathBuf, JSONRPCErrorError> {
    let directory = automation_runs_directory(cwd)?;
    let file_path = PathBuf::from(file_path);
    if !file_path.is_absolute() {
        return Err(invalid_params("filePath must be an absolute path"));
    }
    if file_path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(invalid_params("filePath must not contain parent segments"));
    }
    if file_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("json")
    {
        return Err(invalid_params("filePath must point to a JSON run file"));
    }
    if !file_path.starts_with(&directory) {
        return Err(invalid_params(format!(
            "filePath must be inside {}",
            directory.display()
        )));
    }

    Ok(file_path)
}

fn validate_record_file_path(
    cwd: &str,
    kind: DomainKind,
    file_path: &str,
) -> Result<PathBuf, JSONRPCErrorError> {
    let directory = domain_directory(cwd, kind)?;
    let file_path = PathBuf::from(file_path);
    if !file_path.is_absolute() {
        return Err(invalid_params("filePath must be an absolute path"));
    }
    if file_path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(invalid_params("filePath must not contain parent segments"));
    }
    if file_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("json")
    {
        return Err(invalid_params("filePath must point to a JSON config file"));
    }
    if !file_path.starts_with(&directory) {
        return Err(invalid_params(format!(
            "filePath must be inside {}",
            directory.display()
        )));
    }

    Ok(file_path)
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

fn tool_kind(config: &JsonValue) -> Option<ToolConfigKind> {
    match config.get("kind").and_then(JsonValue::as_str) {
        Some("mcp") => Some(ToolConfigKind::Mcp),
        Some("skill") => Some(ToolConfigKind::Skill),
        _ => None,
    }
}

fn tool_identity(config: &JsonValue) -> Option<&str> {
    config
        .get("id")
        .or_else(|| config.get("name"))
        .and_then(JsonValue::as_str)
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
