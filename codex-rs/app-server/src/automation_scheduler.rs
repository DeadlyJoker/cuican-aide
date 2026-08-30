use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use chrono::Utc;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::AutomationRunParams;
use crewon_app_server_protocol::AutomationRunStartParams;
use crewon_app_server_protocol::AutomationRunUpdateParams;
use crewon_app_server_protocol::AutomationRunsListParams;
use crewon_app_server_protocol::AutomationUpdateParams;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::UserInput;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio::fs;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::ConnectionRequestId;
use crate::request_processors::CrewonDomainRequestProcessor;
use crate::request_processors::ThreadRequestProcessor;
use crate::request_processors::TurnRequestProcessor;

const AUTOMATION_SCHEDULER_CONNECTION_ID: ConnectionId = ConnectionId(u64::MAX - 1);
const AUTOMATION_SCHEDULER_INTERVAL: Duration = Duration::from_secs(15);
const AUTOMATION_RUNNING_STALE_AFTER_SECONDS: i64 = 6 * 60 * 60;
const AUTOMATION_SCHEDULER_INDEX_DIR: &str = "automation-scheduler";
const AUTOMATION_SCHEDULER_INDEX_FILE: &str = "workspaces.json";
const MAX_AUTOMATION_WORKSPACES: usize = 64;

#[derive(Clone)]
pub(crate) struct AutomationScheduler {
    inner: Arc<AutomationSchedulerInner>,
}

struct AutomationSchedulerInner {
    codex_home: PathBuf,
    domain_processor: Arc<CrewonDomainRequestProcessor>,
    thread_processor: ThreadRequestProcessor,
    turn_processor: TurnRequestProcessor,
    workspaces: Mutex<Vec<String>>,
    index_write_semaphore: Semaphore,
    wake: Notify,
    running: AtomicBool,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationWorkspaceIndex {
    version: u32,
    cwds: Vec<AutomationWorkspaceEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationWorkspaceEntry {
    cwd: String,
    updated_at: i64,
}

impl AutomationScheduler {
    pub(crate) fn new(
        codex_home: PathBuf,
        domain_processor: Arc<CrewonDomainRequestProcessor>,
        thread_processor: ThreadRequestProcessor,
        turn_processor: TurnRequestProcessor,
    ) -> Self {
        Self {
            inner: Arc::new(AutomationSchedulerInner {
                codex_home,
                domain_processor,
                thread_processor,
                turn_processor,
                workspaces: Mutex::new(Vec::new()),
                index_write_semaphore: Semaphore::new(1),
                wake: Notify::new(),
                running: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn start(&self) {
        if self.inner.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let scheduler = self.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.inner.running.store(false, Ordering::SeqCst);
            tracing::warn!("skipping automation scheduler without a Tokio runtime");
            return;
        };
        handle.spawn(async move { scheduler.run().await });
    }

    pub(crate) async fn remember_workspace(&self, cwd: &str) {
        let cwd = cwd.trim();
        if cwd.is_empty() {
            return;
        }
        let changed = {
            let mut workspaces = self.inner.workspaces.lock().await;
            if workspaces.first().is_some_and(|existing| existing == cwd) {
                false
            } else {
                workspaces.retain(|existing| existing != cwd);
                workspaces.insert(0, cwd.to_string());
                workspaces.truncate(MAX_AUTOMATION_WORKSPACES);
                true
            }
        };
        if changed && let Err(err) = self.write_workspace_index().await {
            tracing::warn!(cwd, error = %err, "failed to persist automation workspace");
        }
        self.inner.wake.notify_one();
    }

    async fn run(&self) {
        self.load_workspace_index().await;
        loop {
            self.run_due_workspaces().await;
            tokio::select! {
                () = tokio::time::sleep(AUTOMATION_SCHEDULER_INTERVAL) => {}
                () = self.inner.wake.notified() => {}
            }
        }
    }

    async fn load_workspace_index(&self) {
        let path = workspace_index_path(&self.inner.codex_home);
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "failed to read automation workspace index");
                return;
            }
        };
        let Ok(mut index) = serde_json::from_slice::<AutomationWorkspaceIndex>(&bytes) else {
            tracing::warn!(path = %path.display(), "ignored invalid automation workspace index");
            return;
        };
        index
            .cwds
            .sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
        let mut workspaces = self.inner.workspaces.lock().await;
        for entry in index.cwds {
            if !workspaces.contains(&entry.cwd) {
                workspaces.push(entry.cwd);
            }
        }
        workspaces.truncate(MAX_AUTOMATION_WORKSPACES);
    }

    async fn write_workspace_index(&self) -> Result<(), String> {
        let _permit = self
            .inner
            .index_write_semaphore
            .acquire()
            .await
            .map_err(|err| err.to_string())?;
        let path = workspace_index_path(&self.inner.codex_home);
        let entries = self
            .inner
            .workspaces
            .lock()
            .await
            .iter()
            .map(|cwd| AutomationWorkspaceEntry {
                cwd: cwd.clone(),
                updated_at: Utc::now().timestamp(),
            })
            .collect();
        let index = AutomationWorkspaceIndex {
            version: 1,
            cwds: entries,
        };
        let parent = path
            .parent()
            .ok_or_else(|| "automation workspace index has no parent".to_string())?;
        fs::create_dir_all(parent)
            .await
            .map_err(|err| err.to_string())?;
        let mut bytes = serde_json::to_vec_pretty(&index).map_err(|err| err.to_string())?;
        bytes.push(b'\n');
        fs::write(path, bytes).await.map_err(|err| err.to_string())
    }

    async fn run_due_workspaces(&self) {
        let workspaces = self.inner.workspaces.lock().await.clone();
        for cwd in workspaces {
            self.run_due_for_workspace(&cwd).await;
        }
    }

    async fn run_due_for_workspace(&self, cwd: &str) {
        let response = self
            .inner
            .domain_processor
            .automation_list(AutomationListParams {
                cwd: cwd.to_string(),
                cursor: None,
                limit: Some(100),
            })
            .await;
        let records = match response {
            Ok(response) => response.data,
            Err(err) => {
                tracing::warn!(cwd, error = %err.message, "failed to list scheduled automations");
                return;
            }
        };
        for record in records {
            if automation_is_due(&record.config, Utc::now().timestamp()) {
                self.run_due_record(cwd, record).await;
            }
        }
    }

    async fn run_due_record(&self, cwd: &str, record: CrewonDomainConfigRecord) {
        let now = Utc::now().timestamp();
        let Some(thread_id) = record
            .config
            .get("threadId")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|thread_id| !thread_id.is_empty())
        else {
            tracing::warn!(file_path = %record.file_path, "scheduled automation has no threadId");
            return;
        };
        let runs = self
            .inner
            .domain_processor
            .automation_runs_list(AutomationRunsListParams {
                cwd: cwd.to_string(),
                thread_id: Some(thread_id.to_string()),
                cursor: None,
                limit: Some(1),
            })
            .await;
        if let Ok(response) = runs
            && let Some(latest) = response.data.first()
            && latest.run.status == "running"
        {
            if latest.run.started_at > now - AUTOMATION_RUNNING_STALE_AFTER_SECONDS {
                return;
            }
            if let Err(err) = self
                .inner
                .domain_processor
                .automation_run_update(AutomationRunUpdateParams {
                    cwd: cwd.to_string(),
                    file_path: latest.file_path.clone(),
                    status: "failed".to_string(),
                    completed_at: Some(now),
                })
                .await
            {
                tracing::warn!(file_path = %latest.file_path, error = %err.message, "failed to close stale automation run");
                return;
            }
        }
        let Some((scheduled_at, claimed_config)) = claim_next_run(record.config, now) else {
            return;
        };
        if let Err(err) = self
            .inner
            .domain_processor
            .automation_update(AutomationUpdateParams {
                cwd: cwd.to_string(),
                file_path: record.file_path.clone(),
                config: claimed_config.clone(),
            })
            .await
        {
            tracing::warn!(file_path = %record.file_path, error = %err.message, "failed to claim scheduled automation");
            return;
        }
        let note = Some(format!("定时触发 · 计划时间 {scheduled_at}"));
        let prepared = match self
            .inner
            .domain_processor
            .automation_run_start_prepare(AutomationRunStartParams {
                cwd: cwd.to_string(),
                config: claimed_config.clone(),
                note: note.clone(),
                locale: Some("zh-CN".to_string()),
                client_user_message_id: None,
            })
            .await
        {
            Ok(prepared) => prepared,
            Err(err) => {
                self.record_start_failure(cwd, claimed_config, note, &err.message)
                    .await;
                return;
            }
        };
        if let Err(err) = self
            .inner
            .thread_processor
            .ensure_thread_loaded_for_office_dispatch(
                &prepared.thread_id,
                AUTOMATION_SCHEDULER_CONNECTION_ID,
            )
            .await
        {
            self.record_start_failure(cwd, claimed_config, note, &err.message)
                .await;
            return;
        }
        let request_id = ConnectionRequestId {
            connection_id: AUTOMATION_SCHEDULER_CONNECTION_ID,
            request_id: RequestId::String(format!("automation-schedule-{}", Uuid::new_v4())),
        };
        let turn_response = self
            .inner
            .turn_processor
            .turn_start_response(
                request_id,
                TurnStartParams {
                    thread_id: prepared.thread_id.clone(),
                    client_user_message_id: prepared.client_user_message_id.clone(),
                    input: vec![UserInput::Text {
                        text: prepared.prompt.clone(),
                        text_elements: Vec::new(),
                    }],
                    cwd: Some(PathBuf::from(&prepared.cwd)),
                    ..TurnStartParams::default()
                },
                Some("app-server-automation-scheduler".to_string()),
                /*app_server_client_version*/ None,
            )
            .await;
        match turn_response {
            Ok(response) => {
                if let Err(err) = self
                    .inner
                    .domain_processor
                    .automation_run_start_record(&prepared, &response.turn.id)
                    .await
                {
                    tracing::warn!(thread_id = %prepared.thread_id, error = %err.message, "failed to record scheduled automation run");
                }
            }
            Err(err) => {
                self.record_start_failure(cwd, claimed_config, note, &err.message)
                    .await;
            }
        }
    }

    async fn record_start_failure(
        &self,
        cwd: &str,
        config: JsonValue,
        note: Option<String>,
        error: &str,
    ) {
        let note = Some(format!("{} · 启动失败：{error}", note.unwrap_or_default()));
        let run = self
            .inner
            .domain_processor
            .automation_run(AutomationRunParams {
                cwd: cwd.to_string(),
                config,
                note,
                turn_id: None,
            })
            .await;
        let Ok(run) = run else {
            tracing::warn!(
                cwd,
                error,
                "failed to persist scheduled automation start failure"
            );
            return;
        };
        if let Err(err) = self
            .inner
            .domain_processor
            .automation_run_update(AutomationRunUpdateParams {
                cwd: cwd.to_string(),
                file_path: run.file_path,
                status: "failed".to_string(),
                completed_at: Some(Utc::now().timestamp()),
            })
            .await
        {
            tracing::warn!(cwd, error = %err.message, "failed to finalize scheduled automation start failure");
        }
    }
}

fn workspace_index_path(codex_home: &Path) -> PathBuf {
    codex_home
        .join(AUTOMATION_SCHEDULER_INDEX_DIR)
        .join(AUTOMATION_SCHEDULER_INDEX_FILE)
}

fn automation_is_due(config: &JsonValue, now: i64) -> bool {
    config.get("enabled").and_then(JsonValue::as_bool) == Some(true)
        && config.get("status").and_then(JsonValue::as_str) != Some("disabled")
        && config
            .get("trigger")
            .and_then(JsonValue::as_object)
            .is_some_and(|trigger| {
                trigger.get("type").and_then(JsonValue::as_str) == Some("schedule")
                    && trigger
                        .get("nextRunAt")
                        .and_then(JsonValue::as_i64)
                        .is_some_and(|next_run_at| next_run_at <= now)
            })
}

fn claim_next_run(mut config: JsonValue, now: i64) -> Option<(i64, JsonValue)> {
    let object = config.as_object_mut()?;
    let trigger = object.get_mut("trigger")?.as_object_mut()?;
    let scheduled_at = trigger.get("nextRunAt")?.as_i64()?;
    if scheduled_at > now {
        return None;
    }
    let schedule_type = trigger
        .get("scheduleType")
        .and_then(JsonValue::as_str)
        .unwrap_or("daily")
        .to_string();
    trigger.insert("lastScheduledAt".to_string(), JsonValue::from(scheduled_at));
    if schedule_type == "once" {
        trigger.insert("nextRunAt".to_string(), JsonValue::Null);
        object.insert("enabled".to_string(), JsonValue::Bool(false));
        object.insert(
            "status".to_string(),
            JsonValue::String("disabled".to_string()),
        );
    } else {
        let interval_seconds = trigger
            .get("intervalSeconds")
            .and_then(JsonValue::as_i64)
            .or_else(|| {
                trigger
                    .get("intervalMinutes")
                    .and_then(JsonValue::as_i64)
                    .map(|minutes| minutes * 60)
            })
            .unwrap_or_else(|| {
                if schedule_type == "weekly" {
                    7 * 86_400
                } else {
                    86_400
                }
            })
            .clamp(60, 366 * 86_400);
        let elapsed_intervals = (now - scheduled_at).div_euclid(interval_seconds) + 1;
        trigger.insert(
            "nextRunAt".to_string(),
            JsonValue::from(scheduled_at + elapsed_intervals * interval_seconds),
        );
    }
    object.insert("updatedAt".to_string(), JsonValue::from(now));
    Some((scheduled_at, config))
}

#[cfg(test)]
#[path = "automation_scheduler_tests.rs"]
mod tests;
