use crate::Error;
use alloc::vec::Vec;
use ckb_std::ckb_types::packed::Script;
use ckb_std::ckb_types::prelude::*;

const BECH32_CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const SHORT_PAYLOAD_SIGHASH: u8 = 0x01;

/// Decode a CKB address (short bech32 or full bech32m) and return the lock
/// script args contained in it. Checksum verification is intentionally
/// skipped: the signature verification binds the decoded value anyway.
pub fn decode_lock_args(address: &str) -> Result<Vec<u8>, Error> {
    let (hrp, values5) = bech32_decode(address)?;
    if hrp != "ckb" && hrp != "ckt" {
        return Err(Error::WitnessFormat);
    }
    let payload = convert_bits(&values5, 5, 8, false)?;
    if payload.is_empty() {
        return Err(Error::WitnessFormat);
    }
    match payload[0] {
        // short address (deprecated): [0x01, args(20)]
        SHORT_PAYLOAD_SIGHASH => {
            if payload.len() != 21 {
                return Err(Error::WitnessFormat);
            }
            return Ok(payload[1..].to_vec());
        }
        // compact full address (CCC style): [0x00, code_hash(32), hash_type(1), args..]
        0x00 => {
            if payload.len() < 34 {
                return Err(Error::WitnessFormat);
            }
            return Ok(payload[34..].to_vec());
        }
        _ => {}
    }
    // full address: molecule serialized Script
    let script = Script::from_slice(&payload).map_err(|_| Error::WitnessFormat)?;
    let args: Vec<u8> = script.args().unpack();
    Ok(args)
}

fn bech32_decode(addr: &str) -> Result<(alloc::string::String, Vec<u8>), Error> {
    let bytes = addr.as_bytes();
    if bytes.len() < 8 || bytes.len() > 1024 {
        return Err(Error::WitnessFormat);
    }
    let pos = addr.rfind('1').ok_or(Error::WitnessFormat)?;
    if pos == 0 {
        return Err(Error::WitnessFormat);
    }
    let hrp = &addr[..pos];
    let mut values = Vec::new();
    for c in addr[pos + 1..].bytes() {
        let v = BECH32_CHARSET
            .iter()
            .position(|&x| x == c)
            .ok_or(Error::WitnessFormat)?;
        values.push(v as u8);
    }
    // drop the 6 checksum characters
    if values.len() < 6 {
        return Err(Error::WitnessFormat);
    }
    values.truncate(values.len() - 6);
    Ok((alloc::string::String::from(hrp), values))
}

fn convert_bits(data: &[u8], from_bits: u32, to_bits: u32, pad: bool) -> Result<Vec<u8>, Error> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    let maxv: u32 = (1 << to_bits) - 1;
    for &value in data {
        let value = value as u32;
        if value >> from_bits != 0 {
            return Err(Error::WitnessFormat);
        }
        acc = (acc << from_bits) | value;
        bits += from_bits;
        while bits >= to_bits {
            bits -= to_bits;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to_bits - bits)) & maxv) as u8);
        }
    } else if bits >= from_bits || ((acc << (to_bits - bits)) & maxv) != 0 {
        return Err(Error::WitnessFormat);
    }
    Ok(out)
}
