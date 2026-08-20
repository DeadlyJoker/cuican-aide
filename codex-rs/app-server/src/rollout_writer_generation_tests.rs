use std::io::ErrorKind;

use crewon_rollout::RolloutWriterGenerationMode;
use crewon_rollout::acquire_rollout_writer_generation;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::INCOMPATIBLE_GENERATION_ERROR;
use super::acquire_for_app_server;
use super::configured_mode;

#[test]
fn configured_generation_matches_the_compiled_artifact() {
    assert_eq!(
        configured_mode(),
        RolloutWriterGenerationMode::LeaseAwareShared
    );
}

#[test]
fn incompatible_generation_fails_with_stable_startup_error() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let _incompatible = acquire_rollout_writer_generation(
        home.path(),
        RolloutWriterGenerationMode::LegacyFenceExclusive,
    )?;

    let error = acquire_for_app_server(home.path())
        .expect_err("compiled app-server generation must fail closed on an incompatible owner");
    assert_eq!(error.kind(), ErrorKind::WouldBlock);
    assert_eq!(error.to_string(), INCOMPATIBLE_GENERATION_ERROR);
    Ok(())
}
