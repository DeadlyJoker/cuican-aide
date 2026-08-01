use std::fs;
use std::process::Command;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::RolloutWriterGenerationMode;
use super::acquire_rollout_writer_generation;

#[test]
fn lease_aware_generations_share_one_home() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let _first = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )?;
    let _second = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )?;
    Ok(())
}

#[test]
fn legacy_generation_excludes_every_other_generation() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let legacy = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LegacyFenceExclusive,
    )?;

    let legacy_error = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LegacyFenceExclusive,
    )
    .expect_err("legacy generation must exclude another legacy generation");
    assert_eq!(legacy_error.kind(), std::io::ErrorKind::WouldBlock);

    let lease_aware_error = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )
    .expect_err("legacy generation must exclude a lease-aware generation");
    assert_eq!(lease_aware_error.kind(), std::io::ErrorKind::WouldBlock);

    drop(legacy);
    let _replacement = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )?;
    Ok(())
}

#[test]
fn lease_aware_generation_excludes_legacy_generation() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let lease_aware = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )?;

    let error = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LegacyFenceExclusive,
    )
    .expect_err("lease-aware generation must exclude a legacy generation");
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);

    drop(lease_aware);
    let _replacement = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LegacyFenceExclusive,
    )?;
    Ok(())
}

#[cfg(unix)]
#[test]
fn canonical_and_symlink_home_aliases_share_generation_identity() -> anyhow::Result<()> {
    use std::os::unix::fs::symlink;

    let parent = TempDir::new()?;
    let canonical_home = parent.path().join("canonical-home");
    let alias_home = parent.path().join("home-alias");
    fs::create_dir(&canonical_home)?;
    symlink(&canonical_home, &alias_home)?;

    let _shared = acquire_rollout_writer_generation(
        canonical_home.as_path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )?;
    let error = acquire_rollout_writer_generation(
        alias_home.as_path(),
        RolloutWriterGenerationMode::LegacyFenceExclusive,
    )
    .expect_err("symlink alias must resolve to the canonical generation fence");
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    Ok(())
}

#[test]
fn cross_process_lease_aware_generation_shares_and_excludes_legacy() -> anyhow::Result<()> {
    const CHILD_HOME_ENV: &str = "CREWON_GENERATION_SHARED_TEST_CHILD_HOME";
    const TEST_NAME: &str =
        "generation_lock::tests::cross_process_lease_aware_generation_shares_and_excludes_legacy";

    if let Ok(home) = std::env::var(CHILD_HOME_ENV) {
        let home = std::path::PathBuf::from(home);
        let _guard = acquire_rollout_writer_generation(
            home.as_path(),
            RolloutWriterGenerationMode::LeaseAwareShared,
        )?;
        fs::write(home.join("generation-shared-child-ready"), b"ready")?;
        wait_for_path(
            home.join("generation-shared-child-release").as_path(),
            Duration::from_secs(10),
        )?;
        return Ok(());
    }

    let home = TempDir::new()?;
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--exact")
        .arg(TEST_NAME)
        .arg("--nocapture")
        .env(CHILD_HOME_ENV, home.path())
        .spawn()?;
    if let Err(err) = wait_for_path(
        home.path().join("generation-shared-child-ready").as_path(),
        Duration::from_secs(10),
    ) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }

    let shared_error = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )
    .err();
    let legacy_result = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LegacyFenceExclusive,
    );

    fs::write(
        home.path().join("generation-shared-child-release"),
        b"release",
    )?;
    let child_status = child.wait()?;
    assert!(child_status.success());

    if let Some(err) = shared_error {
        return Err(err.into());
    }
    let legacy_error =
        legacy_result.expect_err("legacy generation must conflict with a child shared generation");
    assert_eq!(legacy_error.kind(), std::io::ErrorKind::WouldBlock);
    Ok(())
}

#[test]
fn cross_process_generation_lock_is_released_after_kill() -> anyhow::Result<()> {
    const CHILD_HOME_ENV: &str = "CREWON_GENERATION_LOCK_CRASH_TEST_CHILD_HOME";
    const TEST_NAME: &str =
        "generation_lock::tests::cross_process_generation_lock_is_released_after_kill";

    if let Ok(home) = std::env::var(CHILD_HOME_ENV) {
        let home = std::path::PathBuf::from(home);
        let _guard = acquire_rollout_writer_generation(
            home.as_path(),
            RolloutWriterGenerationMode::LegacyFenceExclusive,
        )?;
        fs::write(home.join("generation-lock-child-ready"), b"ready")?;
        loop {
            thread::park();
        }
    }

    let home = TempDir::new()?;
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--exact")
        .arg(TEST_NAME)
        .arg("--nocapture")
        .env(CHILD_HOME_ENV, home.path())
        .spawn()?;
    if let Err(err) = wait_for_path(
        home.path().join("generation-lock-child-ready").as_path(),
        Duration::from_secs(10),
    ) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }

    let competing_acquire = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    );

    child.kill()?;
    let status = child.wait()?;
    assert!(!status.success());

    let error = competing_acquire
        .expect_err("parent must not cross the child process legacy generation fence");
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);

    let _replacement = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LeaseAwareShared,
    )?;
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
