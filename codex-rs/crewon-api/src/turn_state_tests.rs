use super::*;
use http::HeaderValue;
use pretty_assertions::assert_eq;

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
