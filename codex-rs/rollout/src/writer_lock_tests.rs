use std::fs;
use std::process::Command;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use crewon_protocol::ThreadId;
use crewon_protocol::models::BaseInstructions;
use crewon_protocol::protocol::SessionSource;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::RolloutWriterLease;
use super::lock_path_for_existing_rollout;
use super::lock_path_in_root;
use crate::RolloutConfig;
use crate::RolloutRecorder;
use crate::RolloutRecorderParams;

fn test_config(codex_home: &std::path::Path) -> RolloutConfig {
    RolloutConfig {
        codex_home: codex_home.to_path_buf(),
        sqlite_home: codex_home.to_path_buf(),
        cwd: codex_home.to_path_buf(),
        model_provider_id: "test-provider".to_string(),
        generate_memories: true,
    }
}

#[test]
fn same_thread_lock_is_fail_fast_and_released_on_drop() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let first = RolloutWriterLease::acquire_for_create(home.path(), thread_id)?;

    let err = RolloutWriterLease::acquire_for_create(home.path(), thread_id)
        .expect_err("a second writer must fail while the first lock is alive");
    assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);

    drop(first);
    let _replacement = RolloutWriterLease::acquire_for_create(home.path(), thread_id)?;
    Ok(())
}

#[test]
fn active_archived_plain_and_compressed_aliases_share_one_lock_identity() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let file_name = format!("rollout-2026-07-26T12-00-00-{thread_id}.jsonl");
    let active_dir = home.path().join("sessions/2026/07/26");
    let archived_dir = home.path().join("archived_sessions");
    fs::create_dir_all(&active_dir)?;
    fs::create_dir_all(&archived_dir)?;
    let active_plain = active_dir.join(&file_name);
    let active_compressed = active_plain.with_extension("jsonl.zst");
    let archived_plain = archived_dir.join(&file_name);
    let archived_compressed = archived_plain.with_extension("jsonl.zst");

    let canonical_home = fs::canonicalize(home.path())?;
    let expected = lock_path_in_root(canonical_home.as_path(), thread_id);
    assert_eq!(
        lock_path_for_existing_rollout(&active_plain, thread_id)?,
        expected
    );
    assert_eq!(
        lock_path_for_existing_rollout(&active_compressed, thread_id)?,
        expected
    );
    assert_eq!(
        lock_path_for_existing_rollout(&archived_plain, thread_id)?,
        expected
    );
    assert_eq!(
        lock_path_for_existing_rollout(&archived_compressed, thread_id)?,
        expected
    );
    Ok(())
}

#[test]
fn distinct_thread_ids_do_not_contend() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let _first = RolloutWriterLease::acquire_for_create(home.path(), ThreadId::new())?;
    let _second = RolloutWriterLease::acquire_for_create(home.path(), ThreadId::new())?;
    Ok(())
}

#[test]
fn cross_process_writer_lock_is_fail_fast_and_released_after_exit() -> anyhow::Result<()> {
    const CHILD_HOME_ENV: &str = "CREWON_WRITER_LOCK_TEST_CHILD_HOME";
    const CHILD_THREAD_ENV: &str = "CREWON_WRITER_LOCK_TEST_CHILD_THREAD";
    const TEST_NAME: &str =
        "writer_lock::tests::cross_process_writer_lock_is_fail_fast_and_released_after_exit";

    if let (Ok(home), Ok(thread_id)) = (
        std::env::var(CHILD_HOME_ENV),
        std::env::var(CHILD_THREAD_ENV),
    ) {
        let home = std::path::PathBuf::from(home);
        let thread_id = ThreadId::from_string(&thread_id)?;
        let _lease = RolloutWriterLease::acquire(home.as_path(), thread_id)?;
        fs::write(home.join("writer-lock-child-ready"), b"ready")?;
        wait_for_path(
            home.join("writer-lock-child-release").as_path(),
            Duration::from_secs(10),
        )?;
        return Ok(());
    }

    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--exact")
        .arg(TEST_NAME)
        .arg("--nocapture")
        .env(CHILD_HOME_ENV, home.path())
        .env(CHILD_THREAD_ENV, thread_id.to_string())
        .spawn()?;
    if let Err(err) = wait_for_path(
        home.path().join("writer-lock-child-ready").as_path(),
        Duration::from_secs(10),
    ) {
        let _ = child.kill();
        return Err(err);
    }

    let err = RolloutWriterLease::acquire(home.path(), thread_id)
        .expect_err("parent process must not acquire the child process writer lease");
    assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);

    fs::write(home.path().join("writer-lock-child-release"), b"release")?;
    assert!(child.wait()?.success());
    let _replacement = RolloutWriterLease::acquire(home.path(), thread_id)?;
    Ok(())
}

#[test]
fn cross_process_writer_lock_is_released_after_abrupt_exit() -> anyhow::Result<()> {
    const CHILD_HOME_ENV: &str = "CREWON_WRITER_LOCK_CRASH_TEST_CHILD_HOME";
    const CHILD_THREAD_ENV: &str = "CREWON_WRITER_LOCK_CRASH_TEST_CHILD_THREAD";
    const TEST_NAME: &str =
        "writer_lock::tests::cross_process_writer_lock_is_released_after_abrupt_exit";

    if let (Ok(home), Ok(thread_id)) = (
        std::env::var(CHILD_HOME_ENV),
        std::env::var(CHILD_THREAD_ENV),
    ) {
        let home = std::path::PathBuf::from(home);
        let thread_id = ThreadId::from_string(&thread_id)?;
        let _lease = RolloutWriterLease::acquire(home.as_path(), thread_id)?;
        fs::write(home.join("writer-lock-crash-child-ready"), b"ready")?;
        loop {
            thread::park();
        }
    }

    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--exact")
        .arg(TEST_NAME)
        .arg("--nocapture")
        .env(CHILD_HOME_ENV, home.path())
        .env(CHILD_THREAD_ENV, thread_id.to_string())
        .spawn()?;
    if let Err(err) = wait_for_path(
        home.path().join("writer-lock-crash-child-ready").as_path(),
        Duration::from_secs(10),
    ) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }

    let competing_acquire = RolloutWriterLease::acquire(home.path(), thread_id);
    child.kill()?;
    let status = child.wait()?;
    assert!(!status.success());

    let err = competing_acquire
        .expect_err("parent process must not acquire the child process writer lease");
    assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);

    let _replacement = RolloutWriterLease::acquire(home.path(), thread_id)?;
    Ok(())
}

fn wait_for_path(path: &std::path::Path, timeout: Duration) -> anyhow::Result<()> {
    let deadline = Instant::now() + timeout;
    while !path.exists() {
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for {}", path.display());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[tokio::test]
async fn recorder_holds_lock_until_shutdown_task_has_exited() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let config = test_config(home.path());
    let thread_id = ThreadId::new();
    let params = || {
        RolloutRecorderParams::new(
            thread_id,
            /*forked_from_id*/ None,
            /*parent_thread_id*/ None,
            SessionSource::LegacyCli,
            /*thread_source*/ None,
            BaseInstructions::default(),
            Vec::new(),
        )
    };
    let first = RolloutRecorder::new(&config, params()).await?;

    let err = match RolloutRecorder::new(&config, params()).await {
        Ok(unexpected) => {
            unexpected.shutdown().await?;
            panic!("a recorder must own the thread lock for its complete task lifetime");
        }
        Err(err) => err,
    };
    assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);

    first.shutdown().await?;
    let replacement = RolloutRecorder::new(&config, params()).await?;
    replacement.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn recorder_discard_drops_pending_items_and_releases_lock() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let config = test_config(home.path());
    let thread_id = ThreadId::new();
    let params = || {
        RolloutRecorderParams::new(
            thread_id,
            /*forked_from_id*/ None,
            /*parent_thread_id*/ None,
            SessionSource::LegacyCli,
            /*thread_source*/ None,
            BaseInstructions::default(),
            Vec::new(),
        )
    };
    let recorder = RolloutRecorder::new(&config, params()).await?;
    let rollout_path = recorder.rollout_path().to_path_buf();

    recorder.discard().await?;
    assert!(!rollout_path.exists());

    let replacement = RolloutRecorder::new(&config, params()).await?;
    replacement.shutdown().await?;
    Ok(())
}
