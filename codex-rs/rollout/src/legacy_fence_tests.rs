use std::fs;
use std::io::Write;
use std::path::Path;

use crewon_protocol::ThreadId;
#[cfg(feature = "legacy-fence-artifact")]
use crewon_protocol::models::BaseInstructions;
#[cfg(feature = "legacy-fence-artifact")]
use crewon_protocol::models::ContentItem;
#[cfg(feature = "legacy-fence-artifact")]
use crewon_protocol::models::ResponseItem;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::RolloutLine;
use crewon_protocol::protocol::SessionMeta;
use crewon_protocol::protocol::SessionMetaLine;
use crewon_protocol::protocol::SessionSource;
use crewon_protocol::protocol::UserInputOnceMarker;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::RolloutFenceState;
use super::RolloutMutation;
use super::classify_rollout_blocking;
#[cfg(feature = "legacy-fence-artifact")]
use crate::RolloutConfig;
#[cfg(feature = "legacy-fence-artifact")]
use crate::RolloutRecorder;
#[cfg(feature = "legacy-fence-artifact")]
use crate::RolloutRecorderParams;
use crate::RolloutWriterLease;
#[cfg(feature = "legacy-fence-artifact")]
use crate::append_rollout_item_to_path;
#[cfg(feature = "legacy-fence-artifact")]
use crate::append_rollout_item_to_path_with_lease;
use crate::is_legacy_fence_violation;
use crate::legacy_fence_violation;

#[test]
fn classifier_detects_every_marker_phase_in_plain_rollouts() -> anyhow::Result<()> {
    for phase in [
        UserInputOnceMarkerPhase::Admission,
        UserInputOnceMarkerPhase::ExecutionFence,
        UserInputOnceMarkerPhase::Unknown,
    ] {
        let home = TempDir::new()?;
        let thread_id = ThreadId::new();
        let rollout_path = rollout_path(home.path(), thread_id);
        write_rollout(
            rollout_path.as_path(),
            thread_id,
            &[RolloutItem::UserInputOnceMarker(marker(thread_id, phase))],
        )?;

        assert_eq!(
            classify_rollout_blocking(rollout_path.as_path()),
            RolloutFenceState::MarkerBearing
        );
    }
    Ok(())
}

#[test]
fn classifier_detects_marker_in_compressed_rollout() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let rollout_path = rollout_path(home.path(), thread_id);
    write_rollout(
        rollout_path.as_path(),
        thread_id,
        &[RolloutItem::UserInputOnceMarker(marker(
            thread_id,
            UserInputOnceMarkerPhase::Admission,
        ))],
    )?;
    compress_rollout(rollout_path.as_path())?;

    assert_eq!(
        classify_rollout_blocking(rollout_path.as_path()),
        RolloutFenceState::MarkerBearing
    );
    Ok(())
}

#[test]
fn classifier_fails_closed_for_malformed_or_unknown_lines() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let malformed = rollout_path(home.path(), thread_id);
    let Some(parent) = malformed.parent() else {
        anyhow::bail!("malformed rollout fixture path has no parent");
    };
    fs::create_dir_all(parent)?;
    fs::write(malformed.as_path(), "{not-json}\n")?;
    assert_eq!(
        classify_rollout_blocking(malformed.as_path()),
        RolloutFenceState::Unreadable
    );
    compress_rollout(malformed.as_path())?;
    assert_eq!(
        classify_rollout_blocking(malformed.as_path()),
        RolloutFenceState::Unreadable
    );

    let unknown = home.path().join("unknown.jsonl");
    fs::write(
        unknown.as_path(),
        r#"{"timestamp":"2026-07-26T00:00:00Z","type":"future_item","payload":{}}
"#,
    )?;
    assert_eq!(
        classify_rollout_blocking(unknown.as_path()),
        RolloutFenceState::Unreadable
    );

    let marker_then_malformed = home.path().join("marker-then-malformed.jsonl");
    write_rollout(
        marker_then_malformed.as_path(),
        thread_id,
        &[RolloutItem::UserInputOnceMarker(marker(
            thread_id,
            UserInputOnceMarkerPhase::Admission,
        ))],
    )?;
    fs::OpenOptions::new()
        .append(true)
        .open(marker_then_malformed.as_path())?
        .write_all(b"{not-json}\n")?;
    assert_eq!(
        classify_rollout_blocking(marker_then_malformed.as_path()),
        RolloutFenceState::Unreadable
    );
    Ok(())
}

#[test]
fn classifier_accepts_known_legacy_ghost_snapshot_lines() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let rollout_path = rollout_path(home.path(), thread_id);
    write_rollout(rollout_path.as_path(), thread_id, &[])?;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(rollout_path.as_path())?;
    writeln!(
        file,
        r#"{{"timestamp":"2026-07-26T00:00:01Z","type":"response_item","payload":{{"type":"ghost_snapshot","ghost_commit":{{"id":"legacy"}}}}}}"#
    )?;
    writeln!(
        file,
        r#"{{"timestamp":"2026-07-26T00:00:02Z","type":"compacted","payload":{{"message":"legacy compact","replacement_history":[{{"type":"ghost_snapshot","ghost_commit":{{"id":"legacy"}}}}]}}}}"#
    )?;

    assert_eq!(
        classify_rollout_blocking(rollout_path.as_path()),
        RolloutFenceState::MarkerFree
    );
    Ok(())
}

#[test]
fn existing_mutation_admission_matches_compile_time_mode() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let rollout_path = rollout_path(home.path(), thread_id);
    write_rollout(
        rollout_path.as_path(),
        thread_id,
        &[RolloutItem::UserInputOnceMarker(marker(
            thread_id,
            UserInputOnceMarkerPhase::Admission,
        ))],
    )?;

    let result = RolloutWriterLease::acquire_for_existing_mutation(
        home.path(),
        rollout_path.as_path(),
        thread_id,
        RolloutMutation::Archive,
    );
    if cfg!(feature = "legacy-fence-artifact") {
        let error = result.expect_err("legacy fence artifact must reject marker-bearing rollout");
        assert!(is_legacy_fence_violation(&error));
        let violation = legacy_fence_violation(&error)
            .expect("legacy fence error should preserve structured rejection");
        assert_eq!(violation.thread_id(), thread_id);
        assert_eq!(violation.mutation(), RolloutMutation::Archive);
        assert_eq!(violation.state(), RolloutFenceState::MarkerBearing);
        assert_eq!(
            error.to_string(),
            format!(
                "legacy fence rejected archive for thread {thread_id}: rollout contains durable user-input-once markers"
            )
        );
        assert!(
            !error
                .to_string()
                .contains(&rollout_path.display().to_string())
        );
    } else {
        let _lease = result?;
    }
    Ok(())
}

#[cfg(feature = "legacy-fence-artifact")]
#[tokio::test]
async fn recorder_rejects_marker_batch_before_persisting_it() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let recorder = RolloutRecorder::new(
        &test_config(home.path()),
        RolloutRecorderParams::new(
            thread_id,
            /*forked_from_id*/ None,
            /*parent_thread_id*/ None,
            SessionSource::LegacyCli,
            /*thread_source*/ None,
            BaseInstructions::default(),
            Vec::new(),
        ),
    )
    .await?;

    let error = recorder
        .record_canonical_items(&[RolloutItem::UserInputOnceMarker(marker(
            thread_id,
            UserInputOnceMarkerPhase::Admission,
        ))])
        .await
        .expect_err("legacy artifact must reject marker batch");
    assert!(is_legacy_fence_violation(&error));

    recorder
        .record_canonical_items(&[assistant_message("ordinary legacy turn")])
        .await?;
    recorder.flush().await?;
    let rollout_path = recorder.rollout_path().to_path_buf();
    recorder.shutdown().await?;
    let (items, loaded_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(rollout_path.as_path()).await?;
    assert_eq!(loaded_thread_id, Some(thread_id));
    assert_eq!(parse_errors, 0);
    assert!(
        items
            .iter()
            .all(|item| !matches!(item, RolloutItem::UserInputOnceMarker(_)))
    );
    Ok(())
}

#[cfg(feature = "legacy-fence-artifact")]
#[tokio::test]
async fn cold_append_rejects_marker_without_changing_bytes() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let rollout_path = rollout_path(home.path(), thread_id);
    write_rollout(rollout_path.as_path(), thread_id, &[])?;
    let before = fs::read(rollout_path.as_path())?;
    let lease = RolloutWriterLease::acquire(home.path(), thread_id)?;

    let error = append_rollout_item_to_path_with_lease(
        &lease,
        rollout_path.as_path(),
        thread_id,
        &RolloutItem::UserInputOnceMarker(marker(thread_id, UserInputOnceMarkerPhase::Admission)),
    )
    .await
    .expect_err("legacy artifact must reject cold marker append");

    assert!(is_legacy_fence_violation(&error));
    assert_eq!(fs::read(rollout_path.as_path())?, before);
    Ok(())
}

#[cfg(feature = "legacy-fence-artifact")]
#[tokio::test]
async fn recorder_resume_rejects_marker_bearing_rollout_without_changing_bytes()
-> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let rollout_path = rollout_path(home.path(), thread_id);
    write_rollout(
        rollout_path.as_path(),
        thread_id,
        &[RolloutItem::UserInputOnceMarker(marker(
            thread_id,
            UserInputOnceMarkerPhase::Admission,
        ))],
    )?;
    let before = fs::read(rollout_path.as_path())?;

    let error = match RolloutRecorder::new(
        &test_config(home.path()),
        RolloutRecorderParams::resume_for_thread(rollout_path.clone(), thread_id),
    )
    .await
    {
        Ok(recorder) => {
            recorder.shutdown().await?;
            anyhow::bail!("legacy artifact unexpectedly resumed marker-bearing rollout");
        }
        Err(error) => error,
    };

    assert!(is_legacy_fence_violation(&error));
    assert_eq!(fs::read(rollout_path.as_path())?, before);
    Ok(())
}

#[cfg(feature = "legacy-fence-artifact")]
#[tokio::test]
async fn cold_append_rejects_marker_bearing_rollout_without_changing_bytes() -> anyhow::Result<()> {
    let home = TempDir::new()?;
    let thread_id = ThreadId::new();
    let rollout_path = rollout_path(home.path(), thread_id);
    write_rollout(
        rollout_path.as_path(),
        thread_id,
        &[RolloutItem::UserInputOnceMarker(marker(
            thread_id,
            UserInputOnceMarkerPhase::ExecutionFence,
        ))],
    )?;
    let before = fs::read(rollout_path.as_path())?;

    let error = append_rollout_item_to_path(
        rollout_path.as_path(),
        &assistant_message("must not append"),
    )
    .await
    .expect_err("legacy artifact must reject append to marker-bearing rollout");

    assert!(is_legacy_fence_violation(&error));
    assert_eq!(fs::read(rollout_path.as_path())?, before);
    Ok(())
}

#[cfg(feature = "legacy-fence-artifact")]
fn test_config(codex_home: &Path) -> RolloutConfig {
    RolloutConfig {
        codex_home: codex_home.to_path_buf(),
        sqlite_home: codex_home.to_path_buf(),
        cwd: codex_home.to_path_buf(),
        model_provider_id: "test-provider".to_string(),
        generate_memories: true,
    }
}

fn rollout_path(home: &Path, thread_id: ThreadId) -> std::path::PathBuf {
    home.join("sessions/2026/07/26")
        .join(format!("rollout-2026-07-26T00-00-00-{thread_id}.jsonl"))
}

fn write_rollout(
    path: &Path,
    thread_id: ThreadId,
    extra_items: &[RolloutItem],
) -> anyhow::Result<()> {
    let Some(parent) = path.parent() else {
        anyhow::bail!("rollout fixture path has no parent");
    };
    fs::create_dir_all(parent)?;
    let mut items = vec![RolloutItem::SessionMeta(SessionMetaLine {
        meta: SessionMeta {
            id: thread_id,
            timestamp: "2026-07-26T00:00:00Z".to_string(),
            cwd: parent.to_path_buf(),
            originator: "test".to_string(),
            client_version: "test".to_string(),
            source: SessionSource::LegacyCli,
            ..Default::default()
        },
        git: None,
        scene_runtime: None,
    })];
    items.extend_from_slice(extra_items);
    let lines = items
        .into_iter()
        .map(|item| RolloutLine {
            timestamp: "2026-07-26T00:00:00Z".to_string(),
            item,
        })
        .map(|line| serde_json::to_string(&line))
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    fs::write(path, format!("{lines}\n"))?;
    Ok(())
}

fn compress_rollout(path: &Path) -> anyhow::Result<()> {
    let input = fs::File::open(path)?;
    let output = fs::File::create(path.with_extension("jsonl.zst"))?;
    let mut encoder = zstd::stream::write::Encoder::new(output, 3)?;
    let mut input = std::io::BufReader::new(input);
    std::io::copy(&mut input, &mut encoder)?;
    encoder.finish()?.flush()?;
    fs::remove_file(path)?;
    Ok(())
}

fn marker(thread_id: ThreadId, phase: UserInputOnceMarkerPhase) -> UserInputOnceMarker {
    UserInputOnceMarker {
        version: 1,
        phase,
        thread_id,
        client_id: "legacy-fence-test".to_string(),
        payload_hash: "hash".to_string(),
        turn_id: "turn".to_string(),
    }
}

#[cfg(feature = "legacy-fence-artifact")]
fn assistant_message(text: &str) -> RolloutItem {
    RolloutItem::ResponseItem(ResponseItem::Message {
        id: None,
        role: "assistant".to_string(),
        content: vec![ContentItem::OutputText {
            text: text.to_string(),
        }],
        phase: None,
    })
}
