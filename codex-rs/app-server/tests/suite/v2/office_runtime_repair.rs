use std::fs::File;
use std::fs::OpenOptions;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use anyhow::Result;
use anyhow::bail;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadLoadedListParams;
use crewon_app_server_protocol::ThreadLoadedListResponse;
use crewon_core::find_thread_path_by_id_str;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const REPAIR_POLL_INTERVAL: Duration = Duration::from_millis(25);
const REPAIR_POLL_ATTEMPTS: usize = 200;

#[derive(Clone, Copy)]
enum MutationOutcome {
    NoLongerMatches,
    #[cfg(unix)]
    PersistenceError,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_runtime_repair_discards_unmaterialized_replacement_after_noop_mutation()
-> Result<()> {
    assert_unsaved_replacement_is_discarded(MutationOutcome::NoLongerMatches).await
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_runtime_repair_discards_unmaterialized_replacement_after_persistence_error()
-> Result<()> {
    assert_unsaved_replacement_is_discarded(MutationOutcome::PersistenceError).await
}

async fn assert_unsaved_replacement_is_discarded(outcome: MutationOutcome) -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let stale_thread_id = Uuid::new_v4().to_string();
    let (record_path, original_record) =
        seed_pending_office_repair(&codex_home, &workspace, &stale_thread_id).await?;
    let record_lock = lock_record(&record_path)?;

    let mut app_server = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_TIMEOUT, app_server.initialize()).await??;

    let replacement_thread_id =
        wait_for_replacement_thread(&mut app_server, &stale_thread_id).await?;
    let replacement_rollout_path = find_thread_path_by_id_str(
        codex_home.path(),
        &replacement_thread_id,
        /*state_db_ctx*/ None,
    )
    .await?
    .ok_or_else(|| anyhow::anyhow!("dedicated Office runtime must be durable before repair"))?;
    assert!(replacement_rollout_path.is_file());

    #[cfg(unix)]
    let mut permissions_guard = None;
    let expected_record = match outcome {
        MutationOutcome::NoLongerMatches => {
            let mut latest_record = original_record.clone();
            latest_record["config"]["workspace"]["members"] = json!([]);
            latest_record["config"]["workspace"]["activity"]["runs"] = json!([]);
            write_json(&record_path, &latest_record).await?;
            latest_record
        }
        #[cfg(unix)]
        MutationOutcome::PersistenceError => {
            permissions_guard = Some(make_parent_read_only(&record_path)?);
            original_record.clone()
        }
    };
    File::unlock(&record_lock)?;

    wait_for_thread_to_be_discarded(&mut app_server, codex_home.path(), &replacement_thread_id)
        .await?;
    assert_eq!(
        find_thread_path_by_id_str(
            codex_home.path(),
            &replacement_thread_id,
            /*state_db_ctx*/ None,
        )
        .await?,
        None,
        "discard must remove the uncommitted durable runtime"
    );
    assert!(!replacement_rollout_path.exists());
    #[cfg(unix)]
    drop(permissions_guard);

    let persisted: JsonValue = serde_json::from_slice(&tokio::fs::read(&record_path).await?)?;
    assert_eq!(persisted, expected_record);
    assert!(
        !persisted.to_string().contains(&replacement_thread_id),
        "a replacement that was not committed must not leak into the Office record"
    );
    Ok(())
}

async fn seed_pending_office_repair(
    codex_home: &TempDir,
    workspace: &TempDir,
    stale_thread_id: &str,
) -> Result<(PathBuf, JsonValue)> {
    let office_dir = workspace.path().join(".crewon").join("offices");
    tokio::fs::create_dir_all(&office_dir).await?;
    let record_path = office_dir.join("compensation-office.json");
    let record = json!({
        "version": 1,
        "kind": "office",
        "savedAt": "2026-07-12T00:00:00.000Z",
        "config": {
            "title": "Runtime compensation Office",
            "workspace": {
                "goal": "Discard an unsaved repair runtime",
                "members": [{
                    "agentId": "agent-engineer",
                    "name": "Engineer",
                    "role": "Build",
                    "threadId": stale_thread_id,
                    "runtime": {
                        "threadId": stale_thread_id
                    }
                }],
                "messages": [],
                "tasks": [],
                "activity": {
                    "runs": [{
                        "id": "office-run-runtime-compensation",
                        "status": "completed",
                        "delegations": [{
                            "id": "office-delegation-runtime-compensation",
                            "member": "Engineer",
                            "agentId": "agent-engineer",
                            "task": "Exercise repair compensation",
                            "status": "pending",
                            "dispatchMode": "auto",
                            "riskSeverity": "low",
                            "approvalRequired": false
                        }]
                    }],
                    "artifacts": []
                }
            }
        }
    });
    write_json(&record_path, &record).await?;

    let scheduler_index_path = codex_home
        .path()
        .join("office-scheduler")
        .join("workspaces.json");
    let scheduler_index_parent = scheduler_index_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("scheduler index path has no parent"))?;
    tokio::fs::create_dir_all(scheduler_index_parent).await?;
    write_json(
        &scheduler_index_path,
        &json!({
            "version": 1,
            "cwds": [{
                "cwd": workspace.path().to_string_lossy(),
                "updatedAt": 1783814400
            }]
        }),
    )
    .await?;
    Ok((record_path, record))
}

fn lock_record(record_path: &Path) -> Result<File> {
    let file_name = record_path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("Office record path has no file name"))?
        .to_string_lossy();
    let lock_path = record_path.with_file_name(format!("{file_name}.lock"));
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    lock_file.lock()?;
    Ok(lock_file)
}

#[cfg(unix)]
struct PermissionsGuard {
    path: PathBuf,
    permissions: std::fs::Permissions,
}

#[cfg(unix)]
impl Drop for PermissionsGuard {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(&self.path, self.permissions.clone());
    }
}

#[cfg(unix)]
fn make_parent_read_only(record_path: &Path) -> Result<PermissionsGuard> {
    let parent = record_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Office record path has no parent"))?
        .to_path_buf();
    let permissions = std::fs::metadata(&parent)?.permissions();
    let mut read_only_permissions = permissions.clone();
    read_only_permissions.set_mode(permissions.mode() & !0o222);
    std::fs::set_permissions(&parent, read_only_permissions)?;
    Ok(PermissionsGuard {
        path: parent,
        permissions,
    })
}

async fn wait_for_replacement_thread(
    app_server: &mut TestAppServer,
    stale_thread_id: &str,
) -> Result<String> {
    let mut last_loaded = Vec::new();
    for _ in 0..REPAIR_POLL_ATTEMPTS {
        last_loaded = loaded_threads(app_server).await?;
        if let Some(thread_id) = last_loaded
            .iter()
            .find(|thread_id| thread_id.as_str() != stale_thread_id)
        {
            return Ok(thread_id.clone());
        }
        tokio::time::sleep(REPAIR_POLL_INTERVAL).await;
    }
    bail!("repair did not create a replacement thread; last loaded threads: {last_loaded:?}")
}

async fn wait_for_thread_to_be_discarded(
    app_server: &mut TestAppServer,
    codex_home: &Path,
    replacement_thread_id: &str,
) -> Result<()> {
    let mut last_loaded = Vec::new();
    let mut last_rollout_path = None;
    for _ in 0..(REPAIR_POLL_ATTEMPTS * 4) {
        last_loaded = loaded_threads(app_server).await?;
        let is_unloaded = !last_loaded
            .iter()
            .any(|thread_id| thread_id == replacement_thread_id);
        if is_unloaded {
            last_rollout_path = find_thread_path_by_id_str(
                codex_home,
                replacement_thread_id,
                /*state_db_ctx*/ None,
            )
            .await?;
        }
        if is_unloaded && last_rollout_path.is_none() {
            return Ok(());
        }
        tokio::time::sleep(REPAIR_POLL_INTERVAL).await;
    }
    bail!(
        "unsaved replacement thread {replacement_thread_id} was not fully discarded; last loaded threads: {last_loaded:?}; rollout path: {last_rollout_path:?}"
    )
}

async fn loaded_threads(app_server: &mut TestAppServer) -> Result<Vec<String>> {
    let request_id = app_server
        .send_thread_loaded_list_request(ThreadLoadedListParams::default())
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        app_server.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let response: ThreadLoadedListResponse = to_response(response)?;
    Ok(response.data)
}

async fn write_json(path: &Path, value: &JsonValue) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    tokio::fs::write(path, bytes).await?;
    Ok(())
}
