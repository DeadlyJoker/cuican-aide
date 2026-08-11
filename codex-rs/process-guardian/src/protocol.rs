use std::io::ErrorKind;
use std::io::Read;

use zeroize::Zeroizing;

use crate::GuardianError;

const MAGIC: [u8; 4] = *b"CRWG";
const VERSION: u8 = 0;
const HEADER_BYTES: usize = 12;
pub(crate) const MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrameKind {
    BootstrapInput,
    Input,
    Shutdown,
}

#[derive(Debug)]
pub(crate) struct Frame {
    pub kind: FrameKind,
    pub payload: Zeroizing<Vec<u8>>,
}

pub(crate) struct FrameReader<R> {
    reader: R,
}

impl<R: Read> FrameReader<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self { reader }
    }

    pub(crate) fn read_bootstrap(&mut self) -> Result<Frame, GuardianError> {
        let frame = self.read_frame()?.ok_or(GuardianError::BootstrapMissing)?;
        if frame.kind != FrameKind::BootstrapInput {
            return Err(GuardianError::BootstrapInvalid);
        }
        Ok(frame)
    }

    pub(crate) fn read_frame(&mut self) -> Result<Option<Frame>, GuardianError> {
        let mut header = [0_u8; HEADER_BYTES];
        loop {
            match self.reader.read(&mut header[..1]) {
                Ok(0) => return Ok(None),
                Ok(1) => break,
                Ok(_) => unreachable!("one-byte read returned more than one byte"),
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return Err(GuardianError::ControlReadFailed),
            }
        }
        self.reader
            .read_exact(&mut header[1..])
            .map_err(|_| GuardianError::FrameInvalid)?;

        if header[..4] != MAGIC || header[4] != VERSION || header[6..8] != [0, 0] {
            return Err(GuardianError::FrameInvalid);
        }
        let kind = match header[5] {
            1 => FrameKind::BootstrapInput,
            2 => FrameKind::Input,
            3 => FrameKind::Shutdown,
            _ => return Err(GuardianError::FrameInvalid),
        };
        let payload_bytes = u32::from_be_bytes(
            header[8..12]
                .try_into()
                .map_err(|_| GuardianError::FrameInvalid)?,
        ) as usize;
        if payload_bytes > MAX_FRAME_BYTES || (kind == FrameKind::Shutdown && payload_bytes != 0) {
            return Err(GuardianError::FrameInvalid);
        }

        let mut payload = Zeroizing::new(vec![0_u8; payload_bytes]);
        self.reader
            .read_exact(&mut payload)
            .map_err(|_| GuardianError::FrameInvalid)?;
        Ok(Some(Frame { kind, payload }))
    }
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
