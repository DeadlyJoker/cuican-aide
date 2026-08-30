use std::io::Cursor;

use pretty_assertions::assert_eq;

use super::FrameKind;
use super::FrameReader;
use super::MAX_FRAME_BYTES;
use crate::GuardianError;

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(12 + payload.len());
    encoded.extend_from_slice(b"CRWG");
    encoded.push(0);
    encoded.push(kind);
    encoded.extend_from_slice(&[0, 0]);
    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(payload);
    encoded
}

#[test]
fn parses_bootstrap_input_and_eof_exactly() {
    let bytes = frame(1, "密钥".as_bytes());
    let mut reader = FrameReader::new(Cursor::new(bytes));
    let parsed = reader.read_bootstrap().unwrap();
    assert_eq!(parsed.kind, FrameKind::BootstrapInput);
    assert_eq!(parsed.payload.as_slice(), "密钥".as_bytes());
    assert!(reader.read_frame().unwrap().is_none());
}

#[test]
fn rejects_noncanonical_and_oversized_frames() {
    let mut noncanonical = frame(1, b"");
    noncanonical[6] = 1;
    let mut oversized = frame(1, b"");
    oversized[8..12].copy_from_slice(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes());
    let cases = [
        (Vec::new(), GuardianError::BootstrapMissing),
        (frame(2, b"first"), GuardianError::BootstrapInvalid),
        (noncanonical, GuardianError::FrameInvalid),
        (oversized, GuardianError::FrameInvalid),
        (frame(3, b"not-empty"), GuardianError::FrameInvalid),
    ];
    for (bytes, expected) in cases {
        assert_eq!(
            FrameReader::new(Cursor::new(bytes))
                .read_bootstrap()
                .unwrap_err(),
            expected
        );
    }
}

#[test]
fn rejects_truncated_header_and_payload() {
    let mut header = frame(1, b"");
    header.truncate(7);
    let mut payload = frame(1, b"secret");
    payload.pop();
    for bytes in [header, payload] {
        assert_eq!(
            FrameReader::new(Cursor::new(bytes))
                .read_bootstrap()
                .unwrap_err(),
            GuardianError::FrameInvalid
        );
    }
}
