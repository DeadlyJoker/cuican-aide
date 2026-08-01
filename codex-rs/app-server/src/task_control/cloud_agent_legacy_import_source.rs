use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use crewon_utils_output_truncation::approx_token_count;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;

const MAX_HISTORY_MESSAGES: usize = 20;
const MAX_CONTEXT_TOKENS: usize = 10_000;
const MAX_MESSAGE_CHARS: usize = 10_000;
const MAX_SESSION_FILE_BYTES: usize = 1_000_000;
const MAX_SESSION_FILES: usize = 1_000;
const MAX_AGENT_ID_BYTES: usize = 128;
const MAX_THREAD_ID_BYTES: usize = 1_024;

pub(super) struct LegacySessionSource {
    pub(super) source_key: String,
    pub(super) source_digest: String,
    pub(super) source_bytes: u64,
    pub(super) rounds: Vec<LegacySessionRound>,
}

pub(super) struct LegacySessionRound {
    pub(super) prompt: String,
    pub(super) output: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(super) enum LegacySessionSourceError {
    #[error("legacy session was not found")]
    NotFound,
    #[error("legacy session source is invalid")]
    InvalidSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLegacySession {
    user_id: i64,
    thread_id: String,
    agent_id: String,
    messages: Vec<StoredLegacyMessage>,
}

#[derive(Deserialize)]
struct StoredLegacyMessage {
    role: String,
    content: String,
}

pub(super) async fn read_legacy_session_source(
    history_root: PathBuf,
    deployment_namespace: String,
    user_id: i64,
    thread_id: String,
    agent_id: String,
) -> Result<LegacySessionSource, LegacySessionSourceError> {
    tokio::task::spawn_blocking(move || {
        read_legacy_session_source_sync(
            &history_root,
            &deployment_namespace,
            user_id,
            &thread_id,
            &agent_id,
        )
    })
    .await
    .map_err(|_| LegacySessionSourceError::InvalidSource)?
}

fn read_legacy_session_source_sync(
    history_root: &Path,
    deployment_namespace: &str,
    user_id: i64,
    thread_id: &str,
    agent_id: &str,
) -> Result<LegacySessionSource, LegacySessionSourceError> {
    validate_request(
        history_root,
        deployment_namespace,
        user_id,
        thread_id,
        agent_id,
    )?;
    let root_metadata = fs::symlink_metadata(history_root).map_err(map_not_found)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    let canonical_root =
        fs::canonicalize(history_root).map_err(|_| LegacySessionSourceError::InvalidSource)?;
    if !canonical_root.is_absolute() {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    enforce_file_count(history_root)?;

    let session_key = session_key(user_id, thread_id, agent_id);
    let file_path = history_root.join(format!("{session_key}.json"));
    let path_metadata = fs::symlink_metadata(&file_path).map_err(map_not_found)?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
        || path_metadata.len() == 0
        || path_metadata.len() > MAX_SESSION_FILE_BYTES as u64
    {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    let canonical_file =
        fs::canonicalize(&file_path).map_err(|_| LegacySessionSourceError::InvalidSource)?;
    if canonical_file.parent() != Some(canonical_root.as_path()) {
        return Err(LegacySessionSourceError::InvalidSource);
    }

    let file = File::open(&file_path).map_err(map_not_found)?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| LegacySessionSourceError::InvalidSource)?;
    let current_metadata =
        fs::symlink_metadata(&file_path).map_err(|_| LegacySessionSourceError::InvalidSource)?;
    if current_metadata.file_type().is_symlink()
        || !current_metadata.is_file()
        || !opened_metadata.is_file()
        || opened_metadata.len() == 0
        || opened_metadata.len() > MAX_SESSION_FILE_BYTES as u64
    {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened_metadata.dev() != current_metadata.dev()
            || opened_metadata.ino() != current_metadata.ino()
        {
            return Err(LegacySessionSourceError::InvalidSource);
        }
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(MAX_SESSION_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LegacySessionSourceError::InvalidSource)?;
    if bytes.is_empty() || bytes.len() > MAX_SESSION_FILE_BYTES {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    let stored = serde_json::from_slice::<StoredLegacySession>(&bytes)
        .map_err(|_| LegacySessionSourceError::InvalidSource)?;
    if stored.user_id != user_id || stored.thread_id != thread_id || stored.agent_id != agent_id {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    let rounds = parse_rounds(stored.messages)?;
    Ok(LegacySessionSource {
        source_key: format!("legacy-source:{deployment_namespace}:{session_key}"),
        source_digest: format!("sha256:{:x}", Sha256::digest(&bytes)),
        source_bytes: bytes.len() as u64,
        rounds,
    })
}

fn validate_request(
    history_root: &Path,
    deployment_namespace: &str,
    user_id: i64,
    thread_id: &str,
    agent_id: &str,
) -> Result<(), LegacySessionSourceError> {
    if !history_root.is_absolute()
        || user_id < 0
        || deployment_namespace.len() != 64
        || !deployment_namespace
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || thread_id.is_empty()
        || thread_id.len() > MAX_THREAD_ID_BYTES
        || thread_id.chars().any(char::is_control)
        || agent_id.is_empty()
        || agent_id.len() > MAX_AGENT_ID_BYTES
        || agent_id.chars().any(char::is_control)
    {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    Ok(())
}

fn enforce_file_count(history_root: &Path) -> Result<(), LegacySessionSourceError> {
    let mut count = 0;
    for entry in fs::read_dir(history_root).map_err(map_not_found)? {
        entry.map_err(|_| LegacySessionSourceError::InvalidSource)?;
        count += 1;
        if count > MAX_SESSION_FILES {
            return Err(LegacySessionSourceError::InvalidSource);
        }
    }
    Ok(())
}

fn parse_rounds(
    messages: Vec<StoredLegacyMessage>,
) -> Result<Vec<LegacySessionRound>, LegacySessionSourceError> {
    if messages.len() > MAX_HISTORY_MESSAGES {
        return Err(LegacySessionSourceError::InvalidSource);
    }
    let mut total_tokens = 0;
    for message in &messages {
        if message.content.trim().is_empty()
            || message.content.chars().count() > MAX_MESSAGE_CHARS
            || !matches!(message.role.as_str(), "user" | "assistant")
        {
            return Err(LegacySessionSourceError::InvalidSource);
        }
        total_tokens += approx_token_count(&message.content);
        if total_tokens > MAX_CONTEXT_TOKENS {
            return Err(LegacySessionSourceError::InvalidSource);
        }
    }
    let mut rounds = Vec::with_capacity(messages.len().div_ceil(2));
    let mut messages = messages.into_iter();
    while let Some(prompt) = messages.next() {
        if prompt.role != "user" {
            return Err(LegacySessionSourceError::InvalidSource);
        }
        let output = match messages.next() {
            Some(output) if output.role == "assistant" => Some(output.content),
            Some(_) => return Err(LegacySessionSourceError::InvalidSource),
            None => None,
        };
        rounds.push(LegacySessionRound {
            prompt: prompt.content,
            output,
        });
    }
    Ok(rounds)
}

pub(super) fn session_key(user_id: i64, thread_id: &str, agent_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(user_id.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(thread_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(agent_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn map_not_found(error: std::io::Error) -> LegacySessionSourceError {
    if error.kind() == std::io::ErrorKind::NotFound {
        LegacySessionSourceError::NotFound
    } else {
        LegacySessionSourceError::InvalidSource
    }
}

#[cfg(test)]
#[path = "cloud_agent_legacy_import_source_tests.rs"]
mod tests;
