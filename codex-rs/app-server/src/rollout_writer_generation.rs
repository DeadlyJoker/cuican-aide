use std::io;
use std::path::Path;

use crewon_rollout::RolloutWriterGenerationGuard;
use crewon_rollout::RolloutWriterGenerationMode;
use crewon_rollout::acquire_rollout_writer_generation;

const INCOMPATIBLE_GENERATION_ERROR: &str = "CREWON_HOME is owned by an incompatible rollout writer generation; stop all CrewON processes using this home before starting this binary";

pub(crate) fn acquire_for_app_server(
    codex_home: &Path,
) -> io::Result<RolloutWriterGenerationGuard> {
    acquire_rollout_writer_generation(codex_home, configured_mode()).map_err(|err| {
        if err.kind() == io::ErrorKind::WouldBlock {
            io::Error::new(io::ErrorKind::WouldBlock, INCOMPATIBLE_GENERATION_ERROR)
        } else {
            io::Error::new(
                err.kind(),
                format!(
                    "failed to initialize rollout writer generation for {}: {err}",
                    codex_home.display()
                ),
            )
        }
    })
}

const fn configured_mode() -> RolloutWriterGenerationMode {
    if cfg!(feature = "legacy-fence-artifact") {
        RolloutWriterGenerationMode::LegacyFenceExclusive
    } else {
        RolloutWriterGenerationMode::LeaseAwareShared
    }
}

#[cfg(test)]
#[path = "rollout_writer_generation_tests.rs"]
mod tests;
