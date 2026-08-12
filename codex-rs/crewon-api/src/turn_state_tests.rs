use super::*;
use http::HeaderValue;
use pretty_assertions::assert_eq;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnStateReference {
    header: String,
    max_bytes: usize,
    state: String,
}

fn reference() -> TurnStateReference {
    let path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/provider-turn-state.reference.json"
    )
    .expect("provider turn-state reference fixture");
    serde_json::from_slice(&std::fs::read(path).expect("read turn-state reference"))
        .expect("parse turn-state reference")
}

#[test]
fn matches_the_shared_typescript_turn_state_reference() {
    let reference = reference();
    assert_eq!(TURN_STATE_HEADER, reference.header);
    assert_eq!(MAX_TURN_STATE_BYTES, reference.max_bytes);

    let state = OnceLock::new();
    let mut headers = HeaderMap::new();
    headers.insert(
        TURN_STATE_HEADER,
        HeaderValue::from_str(&reference.state).expect("reference header"),
    );
    observe_turn_state(&headers, &state).expect("shared bounded state");
    assert_eq!(state.get(), Some(&reference.state));
}

#[test]
fn accepts_one_bounded_value_and_rejects_duplicates_and_conflicts() {
    let state = OnceLock::new();
    let mut headers = HeaderMap::new();
    headers.insert(TURN_STATE_HEADER, HeaderValue::from_static("state-1"));
    observe_turn_state(&headers, &state).expect("bounded state");
    assert_eq!(state.get().map(String::as_str), Some("state-1"));

    headers.append(TURN_STATE_HEADER, HeaderValue::from_static("state-1"));
    assert!(observe_turn_state(&headers, &state).is_err());

    let mut conflicting = HeaderMap::new();
    conflicting.insert(TURN_STATE_HEADER, HeaderValue::from_static("state-2"));
    assert!(observe_turn_state(&conflicting, &state).is_err());
}

#[test]
fn rejects_oversized_values() {
    let state = OnceLock::new();
    let mut headers = HeaderMap::new();
    headers.insert(
        TURN_STATE_HEADER,
        HeaderValue::from_bytes(&vec![b'x'; MAX_TURN_STATE_BYTES + 1]).expect("header"),
    );
    assert!(observe_turn_state(&headers, &state).is_err());
    assert_eq!(state.get(), None);
}

#[test]
fn rejects_values_that_could_hide_fetch_merged_duplicates() {
    for value in ["merged-first, merged-second", "bad\tvalue"] {
        let state = OnceLock::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            TURN_STATE_HEADER,
            HeaderValue::from_str(value).expect("representable header"),
        );
        assert!(observe_turn_state(&headers, &state).is_err());
        assert_eq!(state.get(), None);
    }
}
