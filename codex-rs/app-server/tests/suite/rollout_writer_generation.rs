use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
#[cfg(not(feature = "legacy-fence-artifact"))]
use app_test_support::TestAppServer;
use crewon_rollout::RolloutWriterGenerationMode;
use crewon_rollout::acquire_rollout_writer_generation;
use tempfile::TempDir;
use tokio::process::Command;
use tokio::time::timeout;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const INCOMPATIBLE_GENERATION_ERROR: &str = "CREWON_HOME is owned by an incompatible rollout writer generation; stop all CrewON processes using this home before starting this binary";

#[cfg(not(feature = "legacy-fence-artifact"))]
#[tokio::test]
async fn lease_aware_app_servers_share_one_home_through_initialize() -> Result<()> {
    let home = TempDir::new()?;
    let mut first = TestAppServer::new_without_managed_config(home.path()).await?;
    timeout(STARTUP_TIMEOUT, first.initialize())
        .await
        .context("first lease-aware app-server did not initialize")??;

    let mut second = TestAppServer::new_without_managed_config(home.path()).await?;
    timeout(STARTUP_TIMEOUT, second.initialize())
        .await
        .context("second lease-aware app-server did not initialize while the first was active")??;

    first.shutdown().await?;
    second.shutdown().await?;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn incompatible_generation_fails_before_state_or_listener_startup() -> Result<()> {
    let home = TempDir::new()?;
    let incompatible_mode = if cfg!(feature = "legacy-fence-artifact") {
        RolloutWriterGenerationMode::LeaseAwareShared
    } else {
        RolloutWriterGenerationMode::LegacyFenceExclusive
    };
    let _incompatible_generation =
        acquire_rollout_writer_generation(home.path(), incompatible_mode)?;
    let socket_path = home.path().join("app-server.sock");
    let listen_url = format!("unix://{}", socket_path.display());

    let mut command = Command::new(crewon_utils_cargo_bin::cargo_bin("crewon-app-server")?);
    command
        .arg("--listen")
        .arg(&listen_url)
        .arg("--disable-plugin-startup-tasks-for-tests")
        .current_dir(home.path())
        .env("CREWON_HOME", home.path())
        .env("CODEX_HOME", home.path())
        .env("CODEX_SQLITE_HOME", home.path())
        .env("CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG", "1")
        .env("RUST_LOG", "warn")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = timeout(STARTUP_TIMEOUT, command.output())
        .await
        .context("app-server did not fail fast on an incompatible rollout generation")??;
    assert!(
        !output.status.success(),
        "app-server unexpectedly started under an incompatible rollout generation"
    );
    let stderr = String::from_utf8(output.stderr)?;
    assert!(
        stderr.contains(INCOMPATIBLE_GENERATION_ERROR),
        "expected stable generation-fence startup error, got: {stderr}"
    );

    assert_no_runtime_artifacts(home.path(), socket_path.as_path());
    Ok(())
}

#[cfg(unix)]
fn assert_no_runtime_artifacts(home: &Path, socket_path: &Path) {
    let mut paths = Vec::new();
    for database in [
        crewon_state::STATE_DB_FILENAME,
        crewon_state::LOGS_DB_FILENAME,
        crewon_state::GOALS_DB_FILENAME,
        crewon_state::MEMORIES_DB_FILENAME,
    ] {
        paths.push(home.join(database));
        paths.push(home.join(format!("{database}-shm")));
        paths.push(home.join(format!("{database}-wal")));
    }
    paths.extend([
        home.join("sessions"),
        home.join("archived_sessions"),
        socket_path.to_path_buf(),
    ]);

    for path in paths {
        assert!(
            !path.exists(),
            "generation fence must fail before creating runtime artifact {}",
            path.display()
        );
    }
}
