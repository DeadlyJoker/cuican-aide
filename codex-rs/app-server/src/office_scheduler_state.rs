use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crewon_core::path_utils::write_atomically;
use serde::Deserialize;
use serde::Serialize;
use tokio::task;

const OFFICE_SCHEDULER_STATE_DIR: &str = "office-scheduler";
const OFFICE_SCHEDULER_STATE_FILE: &str = "workspaces.json";
const OFFICE_SCHEDULER_STATE_LOCK_FILE: &str = "workspaces.lock";
const OFFICE_SCHEDULER_STATE_VERSION: u32 = 1;
const MAX_OFFICE_SCHEDULER_STATE_BYTES: u64 = 512 * 1024;
const MAX_OFFICE_SCHEDULER_CWD_CHARS: usize = 4_096;
const MAX_OFFICE_SCHEDULER_CURSOR_CHARS: usize = 128;
pub(crate) const MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS: usize = 64;

static OFFICE_SCHEDULER_STATE_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficeSchedulerWorkspacePosition {
    #[serde(default)]
    pub(crate) record_cursor: Option<String>,
    #[serde(default)]
    pub(crate) target_cursor: Option<OfficeSchedulerTargetCursor>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficeSchedulerTargetCursor {
    pub(crate) record_id: String,
    pub(crate) thread_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficeSchedulerState {
    version: u32,
    cwds: Vec<OfficeSchedulerWorkspaceEntry>,
}

impl Default for OfficeSchedulerState {
    fn default() -> Self {
        Self {
            version: OFFICE_SCHEDULER_STATE_VERSION,
            cwds: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficeSchedulerWorkspaceEntry {
    cwd: String,
    updated_at: i64,
    #[serde(default)]
    record_cursor: Option<String>,
    #[serde(default)]
    target_cursor: Option<OfficeSchedulerTargetCursor>,
}

impl OfficeSchedulerWorkspaceEntry {
    fn position(&self) -> OfficeSchedulerWorkspacePosition {
        OfficeSchedulerWorkspacePosition {
            record_cursor: self.record_cursor.clone(),
            target_cursor: self.target_cursor.clone(),
        }
    }
}

pub(crate) async fn remember_workspace(codex_home: &Path, cwd: &str) -> io::Result<()> {
    let cwd = validate_cwd(cwd)?.to_string();
    transact(codex_home, move |state| {
        let position = state
            .cwds
            .iter()
            .find(|entry| entry.cwd == cwd)
            .map(OfficeSchedulerWorkspaceEntry::position)
            .unwrap_or_default();
        upsert_workspace(state, cwd, position);
        Ok(((), true))
    })
    .await
}

pub(crate) async fn workspace_cwds(codex_home: &Path) -> io::Result<Vec<String>> {
    transact(codex_home, |state| {
        Ok((
            state.cwds.iter().map(|entry| entry.cwd.clone()).collect(),
            false,
        ))
    })
    .await
}

pub(crate) async fn workspace_position(
    codex_home: &Path,
    cwd: &str,
) -> io::Result<OfficeSchedulerWorkspacePosition> {
    let cwd = validate_cwd(cwd)?.to_string();
    transact(codex_home, move |state| {
        let position = state
            .cwds
            .iter()
            .find(|entry| entry.cwd == cwd)
            .map(OfficeSchedulerWorkspaceEntry::position)
            .unwrap_or_default();
        Ok((position, false))
    })
    .await
}

pub(crate) async fn compare_exchange_workspace_position(
    codex_home: &Path,
    cwd: &str,
    expected: &OfficeSchedulerWorkspacePosition,
    next: OfficeSchedulerWorkspacePosition,
) -> io::Result<bool> {
    let cwd = validate_cwd(cwd)?.to_string();
    validate_position(&next)?;
    let expected = expected.clone();
    transact(codex_home, move |state| {
        let current = state
            .cwds
            .iter()
            .find(|entry| entry.cwd == cwd)
            .map(OfficeSchedulerWorkspaceEntry::position)
            .unwrap_or_default();
        if current != expected {
            return Ok((false, false));
        }
        upsert_workspace(state, cwd, next);
        Ok((true, true))
    })
    .await
}

fn state_mutex() -> &'static Mutex<()> {
    OFFICE_SCHEDULER_STATE_MUTEX.get_or_init(|| Mutex::new(()))
}

async fn transact<T>(
    codex_home: &Path,
    update: impl FnOnce(&mut OfficeSchedulerState) -> io::Result<(T, bool)> + Send + 'static,
) -> io::Result<T>
where
    T: Send + 'static,
{
    let codex_home = codex_home.to_path_buf();
    task::spawn_blocking(move || {
        let _process_guard = state_mutex()
            .lock()
            .map_err(|_| io::Error::other("office scheduler state mutex is poisoned"))?;
        transact_blocking(&codex_home, update)
    })
    .await
    .map_err(|err| io::Error::other(format!("office scheduler state task failed: {err}")))?
}

fn transact_blocking<T>(
    codex_home: &Path,
    update: impl FnOnce(&mut OfficeSchedulerState) -> io::Result<(T, bool)>,
) -> io::Result<T> {
    let directory = codex_home.join(OFFICE_SCHEDULER_STATE_DIR);
    std::fs::create_dir_all(&directory)?;
    let lock_path = directory.join(OFFICE_SCHEDULER_STATE_LOCK_FILE);
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)?;
    lock_file.lock()?;

    let state_path = directory.join(OFFICE_SCHEDULER_STATE_FILE);
    let mut state = read_state(&state_path)?;
    normalize_state(&mut state);
    let (result, changed) = update(&mut state)?;
    if changed {
        normalize_state(&mut state);
        write_state(&state_path, &state)?;
    }
    Ok(result)
}

fn read_state(path: &Path) -> io::Result<OfficeSchedulerState> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(OfficeSchedulerState::default());
        }
        Err(err) => return Err(err),
    };
    if metadata.len() > MAX_OFFICE_SCHEDULER_STATE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("office scheduler state exceeds {MAX_OFFICE_SCHEDULER_STATE_BYTES} bytes"),
        ));
    }
    let bytes = std::fs::read(path)?;
    let state = serde_json::from_slice::<OfficeSchedulerState>(&bytes).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to parse office scheduler state: {err}"),
        )
    })?;
    if state.version != OFFICE_SCHEDULER_STATE_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported office scheduler state version {}",
                state.version
            ),
        ));
    }
    validate_state(&state)?;
    Ok(state)
}

fn write_state(path: &Path, state: &OfficeSchedulerState) -> io::Result<()> {
    validate_state(state)?;
    let mut contents = serde_json::to_string_pretty(state).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to serialize office scheduler state: {err}"),
        )
    })?;
    contents.push('\n');
    if u64::try_from(contents.len()).unwrap_or(u64::MAX) > MAX_OFFICE_SCHEDULER_STATE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("office scheduler state exceeds {MAX_OFFICE_SCHEDULER_STATE_BYTES} bytes"),
        ));
    }
    write_atomically(path, &contents)
}

fn normalize_state(state: &mut OfficeSchedulerState) {
    state.version = OFFICE_SCHEDULER_STATE_VERSION;
    state
        .cwds
        .sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    let mut seen = HashSet::new();
    state.cwds.retain(|entry| seen.insert(entry.cwd.clone()));
    state.cwds.truncate(MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS);
}

fn upsert_workspace(
    state: &mut OfficeSchedulerState,
    cwd: String,
    position: OfficeSchedulerWorkspacePosition,
) {
    state.cwds.retain(|entry| entry.cwd != cwd);
    state.cwds.insert(
        0,
        OfficeSchedulerWorkspaceEntry {
            cwd,
            updated_at: scheduler_now(),
            record_cursor: position.record_cursor,
            target_cursor: position.target_cursor,
        },
    );
    state.cwds.truncate(MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS);
}

fn validate_state(state: &OfficeSchedulerState) -> io::Result<()> {
    if state.cwds.len() > MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "office scheduler state contains too many workspaces",
        ));
    }
    let mut seen = HashSet::new();
    for entry in &state.cwds {
        validate_cwd(&entry.cwd)?;
        if !seen.insert(entry.cwd.as_str()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "office scheduler state contains duplicate workspaces",
            ));
        }
        validate_position(&entry.position())?;
    }
    Ok(())
}

fn validate_position(position: &OfficeSchedulerWorkspacePosition) -> io::Result<()> {
    if let Some(record_cursor) = position.record_cursor.as_deref() {
        validate_cursor_value(record_cursor, "record cursor")?;
    }
    if let Some(target_cursor) = position.target_cursor.as_ref() {
        validate_cursor_value(&target_cursor.record_id, "target record id")?;
        validate_cursor_value(&target_cursor.thread_id, "target thread id")?;
    }
    Ok(())
}

fn validate_cwd(cwd: &str) -> io::Result<&str> {
    if cwd.is_empty() || cwd != cwd.trim() || !Path::new(cwd).is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "office scheduler cwd must be a trimmed absolute path",
        ));
    }
    if cwd.chars().count() > MAX_OFFICE_SCHEDULER_CWD_CHARS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("office scheduler cwd exceeds {MAX_OFFICE_SCHEDULER_CWD_CHARS} characters"),
        ));
    }
    Ok(cwd)
}

fn validate_cursor_value(value: &str, field: &str) -> io::Result<()> {
    if value.is_empty() || value != value.trim() || value.chars().any(char::is_whitespace) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("office scheduler {field} must be non-empty and contain no whitespace"),
        ));
    }
    if value.chars().count() > MAX_OFFICE_SCHEDULER_CURSOR_CHARS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "office scheduler {field} exceeds {MAX_OFFICE_SCHEDULER_CURSOR_CHARS} characters"
            ),
        ));
    }
    Ok(())
}

fn scheduler_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "office_scheduler_state_tests.rs"]
mod tests;
