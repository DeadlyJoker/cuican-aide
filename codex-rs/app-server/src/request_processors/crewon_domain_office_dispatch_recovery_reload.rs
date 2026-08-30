use crate::request_processors::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery;
use crate::request_processors::crewon_domain_office_dispatch_recovery::locate_office_dispatch_recovery;

use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReloadedOfficeDispatchRecovery {
    pub(crate) config: JsonValue,
    pub(crate) file_path: String,
    pub(crate) recovery: LocatedOfficeDispatchRecovery,
}

/// Reloads and revalidates one exact canonical Office recovery record.
///
/// The caller owns the authority lock. This helper performs no scheduler mutation and never
/// searches for a replacement record when the exact path disappears or changes identity.
pub(crate) async fn reload_exact_office_dispatch_recovery(
    cwd: &str,
    file_path: &str,
    expected: &LocatedOfficeDispatchRecovery,
) -> Result<ReloadedOfficeDispatchRecovery, JSONRPCErrorError> {
    let exact_path = validate_record_file_path(cwd, DomainKind::Office, file_path)?;
    let record = read_record(DomainKind::Office, &exact_path)
        .await?
        .ok_or_else(|| invalid_params("exact Office dispatch recovery record no longer exists"))?;
    let current = locate_office_dispatch_recovery(
        &record.config,
        &expected.intent_id,
        &expected.source_thread_id,
        &expected.source_turn_id,
    )
    .map_err(|_| invalid_params("exact Office dispatch recovery receipt is corrupt"))?
    .ok_or_else(|| invalid_params("exact Office dispatch recovery receipt no longer exists"))?;
    if current != *expected {
        return Err(invalid_params(
            "exact Office dispatch recovery receipt changed after discovery",
        ));
    }
    Ok(ReloadedOfficeDispatchRecovery {
        config: record.config,
        file_path: record.file_path,
        recovery: current,
    })
}

#[cfg(test)]
#[path = "crewon_domain_office_dispatch_recovery_reload_tests.rs"]
mod tests;
