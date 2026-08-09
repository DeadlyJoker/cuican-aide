use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use chrono::DateTime;
use chrono::Utc;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceGatewayWelcome;
use serde::Deserialize;
use serde::Serialize;
use thiserror::Error;

const STATE_SCHEMA_VERSION: &str = "crewon.device-connection-epoch.v0";
const STATE_FILE_PREFIX: &str = "connection-epoch-";
const STATE_FILE_SUFFIX: &str = ".json";
const MAX_STATE_BYTES: u64 = 16 * 1024;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// The socket identity accepted by the durable native connection fence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedGatewayConnection {
    pub device_id: String,
    pub connection_id: String,
    pub gateway_id: String,
    pub connection_epoch: u64,
    pub lease_expires_at: DateTime<Utc>,
}

/// A linearization permit that must be held until an irreversible action starts.
///
/// Accepting a newer Gateway welcome waits for this permit. Conversely, once a
/// newer epoch has been accepted, an old connection can no longer acquire one.
#[derive(Debug)]
#[must_use = "hold the permit until the native side effect has started"]
pub(crate) struct ConnectionEpochPermit<'a> {
    connection: AcceptedGatewayConnection,
    _state: MutexGuard<'a, FenceState>,
}

impl ConnectionEpochPermit<'_> {
    fn connection(&self) -> &AcceptedGatewayConnection {
        &self.connection
    }
}

/// Durable highest-epoch authority for one native Device identity.
///
/// Epoch records are append-only and atomically published into place. The fence
/// persists a higher epoch before exposing it to the capability dispatcher, so
/// a process restart cannot accept an older Gateway socket.
#[derive(Debug)]
pub struct ConnectionEpochFence {
    device_id: String,
    state_directory: PathBuf,
    state: Mutex<FenceState>,
}

impl ConnectionEpochFence {
    pub fn open(
        device_id: impl Into<String>,
        state_directory: impl Into<PathBuf>,
    ) -> Result<Self, ConnectionEpochFenceError> {
        let device_id = device_id.into();
        require_opaque_id(&device_id)?;
        let state_directory = state_directory.into();
        create_private_state_directory(&state_directory)?;
        let accepted = load_highest_epoch(&state_directory, &device_id)?;
        Ok(Self {
            device_id,
            state_directory,
            state: Mutex::new(FenceState { accepted }),
        })
    }

    /// Persists and accepts a strictly newer, unexpired Gateway connection.
    pub(crate) fn accept_welcome(
        &self,
        welcome: &DeviceGatewayWelcome,
        now: DateTime<Utc>,
    ) -> Result<AcceptedGatewayConnection, ConnectionEpochFenceError> {
        if welcome.schema_version != "crewon.device-welcome.v0"
            || welcome.protocol_version != 1
            || welcome.connection_epoch == 0
        {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_welcome_invalid",
            ));
        }
        if welcome.device_id != self.device_id {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_identity_mismatch",
            ));
        }
        require_opaque_id(&welcome.connection_id)?;
        require_opaque_id(&welcome.gateway_id)?;
        parse_timestamp(&welcome.sent_at)?;
        let lease_expires_at = parse_timestamp(&welcome.lease_expires_at)?;
        if lease_expires_at <= now {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_lease_expired",
            ));
        }
        let accepted = AcceptedGatewayConnection {
            device_id: welcome.device_id.clone(),
            connection_id: welcome.connection_id.clone(),
            gateway_id: welcome.gateway_id.clone(),
            connection_epoch: welcome.connection_epoch,
            lease_expires_at,
        };
        let mut state = self.lock_state()?;
        if state
            .accepted
            .as_ref()
            .is_some_and(|current| accepted.connection_epoch <= current.connection_epoch)
        {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_epoch_stale",
            ));
        }
        persist_epoch(&self.state_directory, &accepted)?;
        state.accepted = Some(accepted.clone());
        Ok(accepted)
    }

    /// Acquires the permit required immediately before native side-effect start.
    pub(crate) fn authorize_command<'a>(
        &'a self,
        connection: &AcceptedGatewayConnection,
        command: &DeviceExecutionCommand,
    ) -> Result<ConnectionEpochPermit<'a>, ConnectionEpochFenceError> {
        let state = self.lock_state()?;
        if state.accepted.as_ref() != Some(connection) {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_epoch_stale",
            ));
        }
        if command.device_id != self.device_id {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_command_identity_mismatch",
            ));
        }
        Ok(ConnectionEpochPermit {
            connection: connection.clone(),
            _state: state,
        })
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, FenceState>, ConnectionEpochFenceError> {
        self.state
            .lock()
            .map_err(|_| ConnectionEpochFenceError::new("device_connection_epoch_state_poisoned"))
    }
}

#[derive(Debug)]
struct FenceState {
    accepted: Option<AcceptedGatewayConnection>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedConnectionEpoch {
    schema_version: String,
    device_id: String,
    connection_id: String,
    gateway_id: String,
    connection_epoch: u64,
    lease_expires_at: String,
}

impl PersistedConnectionEpoch {
    fn from_accepted(accepted: &AcceptedGatewayConnection) -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION.to_string(),
            device_id: accepted.device_id.clone(),
            connection_id: accepted.connection_id.clone(),
            gateway_id: accepted.gateway_id.clone(),
            connection_epoch: accepted.connection_epoch,
            lease_expires_at: accepted.lease_expires_at.to_rfc3339(),
        }
    }

    fn into_accepted(
        self,
        expected_device_id: &str,
        filename_epoch: u64,
    ) -> Result<AcceptedGatewayConnection, ConnectionEpochFenceError> {
        if self.schema_version != STATE_SCHEMA_VERSION
            || self.device_id != expected_device_id
            || self.connection_epoch != filename_epoch
        {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_epoch_state_invalid",
            ));
        }
        require_opaque_id(&self.device_id)?;
        require_opaque_id(&self.connection_id)?;
        require_opaque_id(&self.gateway_id)?;
        if self.connection_epoch == 0 {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_epoch_state_invalid",
            ));
        }
        Ok(AcceptedGatewayConnection {
            device_id: self.device_id,
            connection_id: self.connection_id,
            gateway_id: self.gateway_id,
            connection_epoch: self.connection_epoch,
            lease_expires_at: parse_timestamp(&self.lease_expires_at)?,
        })
    }
}

/// A content-free error suitable for the native protocol boundary.
#[derive(Debug, Error)]
#[error("{code}")]
pub struct ConnectionEpochFenceError {
    pub code: &'static str,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl ConnectionEpochFenceError {
    fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    fn with_source(
        code: &'static str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            source: Some(Box::new(source)),
        }
    }
}

fn load_highest_epoch(
    state_directory: &Path,
    expected_device_id: &str,
) -> Result<Option<AcceptedGatewayConnection>, ConnectionEpochFenceError> {
    let mut highest: Option<AcceptedGatewayConnection> = None;
    let entries = fs::read_dir(state_directory).map_err(|error| {
        ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })?;
        let filename = entry.file_name();
        let Some(filename) = filename.to_str() else {
            continue;
        };
        if !filename.starts_with(STATE_FILE_PREFIX) || !filename.ends_with(STATE_FILE_SUFFIX) {
            continue;
        }
        if !entry
            .file_type()
            .map_err(|error| {
                ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
            })?
            .is_file()
        {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_epoch_state_invalid",
            ));
        }
        let epoch = parse_epoch_filename(filename)?;
        let metadata = entry.metadata().map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })?;
        if metadata.len() == 0 || metadata.len() > MAX_STATE_BYTES {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_epoch_state_invalid",
            ));
        }
        let bytes = fs::read(entry.path()).map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })?;
        let persisted: PersistedConnectionEpoch =
            serde_json::from_slice(&bytes).map_err(|error| {
                ConnectionEpochFenceError::with_source(
                    "device_connection_epoch_state_invalid",
                    error,
                )
            })?;
        let accepted = persisted.into_accepted(expected_device_id, epoch)?;
        if highest
            .as_ref()
            .is_none_or(|current| accepted.connection_epoch > current.connection_epoch)
        {
            highest = Some(accepted);
        }
    }
    Ok(highest)
}

fn persist_epoch(
    state_directory: &Path,
    accepted: &AcceptedGatewayConnection,
) -> Result<(), ConnectionEpochFenceError> {
    let mut bytes = serde_json::to_vec(&PersistedConnectionEpoch::from_accepted(accepted))
        .map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_invalid", error)
        })?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(ConnectionEpochFenceError::new(
            "device_connection_epoch_state_invalid",
        ));
    }
    let epoch = accepted.connection_epoch;
    let final_path = state_directory.join(epoch_filename(epoch));
    let process_id = std::process::id();
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary_path =
        state_directory.join(format!(".connection-epoch-{process_id}-{sequence}.tmp"));
    let result = (|| {
        let mut file = create_private_file(&temporary_path)?;
        file.write_all(&bytes).map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })?;
        file.sync_all().map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })?;
        fs::hard_link(&temporary_path, &final_path).map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })?;
        sync_state_directory(state_directory)?;
        fs::remove_file(&temporary_path).map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })?;
        sync_state_directory(state_directory)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn create_private_state_directory(path: &Path) -> Result<(), ConnectionEpochFenceError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| {
        ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
    })?;
    if !metadata.file_type().is_dir() {
        return Err(ConnectionEpochFenceError::new(
            "device_connection_epoch_state_invalid",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ConnectionEpochFenceError::new(
                "device_connection_epoch_state_permissions_invalid",
            ));
        }
    }
    Ok(())
}

fn create_private_file(path: &Path) -> Result<File, ConnectionEpochFenceError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| {
        ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
    })
}

#[cfg(unix)]
fn sync_state_directory(path: &Path) -> Result<(), ConnectionEpochFenceError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            ConnectionEpochFenceError::with_source("device_connection_epoch_state_io", error)
        })
}

#[cfg(not(unix))]
fn sync_state_directory(_path: &Path) -> Result<(), ConnectionEpochFenceError> {
    Ok(())
}

fn parse_epoch_filename(filename: &str) -> Result<u64, ConnectionEpochFenceError> {
    let epoch = filename
        .strip_prefix(STATE_FILE_PREFIX)
        .and_then(|value| value.strip_suffix(STATE_FILE_SUFFIX))
        .filter(|value| value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|epoch| *epoch > 0)
        .ok_or_else(|| ConnectionEpochFenceError::new("device_connection_epoch_state_invalid"))?;
    if epoch_filename(epoch) != filename {
        return Err(ConnectionEpochFenceError::new(
            "device_connection_epoch_state_invalid",
        ));
    }
    Ok(epoch)
}

fn epoch_filename(epoch: u64) -> String {
    format!("{STATE_FILE_PREFIX}{epoch:020}{STATE_FILE_SUFFIX}")
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, ConnectionEpochFenceError> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| {
            ConnectionEpochFenceError::with_source(
                "device_connection_epoch_timestamp_invalid",
                error,
            )
        })
}

fn require_opaque_id(value: &str) -> Result<(), ConnectionEpochFenceError> {
    let mut bytes = value.bytes();
    if value.len() > 512
        || !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(ConnectionEpochFenceError::new(
            "device_connection_identity_invalid",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "connection_epoch_fence_tests.rs"]
mod tests;
