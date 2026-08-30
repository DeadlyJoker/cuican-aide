use std::borrow::Cow;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::DurableWorkspaceRootResolveOutcome;
use crewon_state::StateRuntime;
use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

use super::workspace::ResolvedWorkspaceRoot;
use crate::error_code::internal_error;

const DURABLE_WORKSPACE_AUTHORITY_UNAVAILABLE: &str = "durable workspace authority is unavailable";

pub(super) async fn resolve_durable_workspace_key(
    state: &StateRuntime,
    root: &ResolvedWorkspaceRoot,
) -> Result<String, JSONRPCErrorError> {
    #[cfg(unix)]
    let root_bytes: Cow<'_, [u8]> = Cow::Borrowed(root.canonical_root.as_os_str().as_bytes());
    #[cfg(windows)]
    let root_bytes: Cow<'_, [u8]> = Cow::Owned(
        root.canonical_root
            .as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect(),
    );
    #[cfg(not(any(unix, windows)))]
    let root_bytes: Cow<'_, [u8]> =
        Cow::Borrowed(root.canonical_root.as_os_str().as_encoded_bytes());
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.app-server.workspace-root.v1\0");
    for part in [
        root.node_id.as_bytes(),
        root.environment_id.as_bytes(),
        root_bytes.as_ref(),
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    let root_fingerprint = format!("sha256:{:x}", hasher.finalize());
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .ok_or_else(|| internal_error(DURABLE_WORKSPACE_AUTHORITY_UNAVAILABLE))?;
    let mut proposed = DurableWorkspaceRootRecord {
        workspace_key: format!("workspace:{}", Uuid::now_v7()),
        node_id: root.node_id.clone(),
        environment_id: root.environment_id.clone(),
        root_fingerprint,
        record_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .to_string(),
        created_at,
    };
    proposed.record_hash = proposed.canonical_hash();

    let outcome = state
        .resolve_durable_workspace_root_record(&proposed)
        .await
        .map_err(|error| {
            tracing::warn!(
                error = %error,
                "durable workspace authority failed to resolve a registered root"
            );
            internal_error(DURABLE_WORKSPACE_AUTHORITY_UNAVAILABLE)
        })?;
    match outcome {
        DurableWorkspaceRootResolveOutcome::Created(record)
        | DurableWorkspaceRootResolveOutcome::Existing(record) => Ok(record.workspace_key),
        DurableWorkspaceRootResolveOutcome::CapacityExceeded
        | DurableWorkspaceRootResolveOutcome::Conflict => {
            Err(internal_error(DURABLE_WORKSPACE_AUTHORITY_UNAVAILABLE))
        }
    }
}
