#![no_std]
#![no_main]

mod bech32;
mod json;

use alloc::vec::Vec;
use core::convert::TryInto;

use ckb_hash::blake2b_256;
use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::prelude::*;
use ckb_std::default_alloc;
use ckb_std::entry;
use ckb_std::error::SysError;
use ckb_std::high_level::{
    load_cell, load_cell_lock, load_cell_type, load_script, load_tx_hash, load_witness_args,
    QueryIter,
};

entry!(program_entry);
default_alloc!();

#[repr(i8)]
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Error {
    IndexOutOfBound = 1,
    ItemMissing,
    LengthNotEnough,
    Encoding,
    // Args must be exactly 40 bytes: hash(32) || max_fee(8, u64 LE)
    ArgsEncoding = 6,
    // More than one lock group uses the COMP code hash in this transaction
    MultipleLockGroups,
    // The COMP lock group must contain exactly one input cell
    InvalidInputCount,
    // The transaction must create exactly one successor COMP cell
    InvalidSuccessorCount,
    // COMP shared cells must not carry a type script
    TypeScriptNotAllowed,
    // Successor lock script must be identical to the input lock script
    LockMismatch,
    // Output capacity dropped more than max_fee
    CapacityExceeded,
    // Exactly one of address / signature is present
    InvalidIdentity,
    // Witness message cannot be parsed
    WitnessFormat,
    // Signature verification failed
    SignatureInvalid,
}

const ZERO_SIGNATURE_LEN: usize = 65;

fn program_entry() -> i8 {
    match verify() {
        Ok(()) => 0,
        Err(err) => err as i8,
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Encoding)?;
    let args: Vec<u8> = script.args().unpack();
    if args.len() != 40 {
        return Err(Error::ArgsEncoding);
    }
    let max_fee = u64::from_le_bytes(args[32..40].try_into().map_err(|_| Error::ArgsEncoding)?);

    let code_hash = script.code_hash();
    let hash_type = script.hash_type();

    // Rule: the lock group must contain exactly one input cell (no merge).
    let group_input_count = QueryIter::new(load_cell, Source::GroupInput).count();
    if group_input_count != 1 {
        return Err(Error::InvalidInputCount);
    }

    // Rule: only one COMP lock group may exist in the whole transaction.
    let comp_input_count = QueryIter::new(load_cell_lock, Source::Input)
        .filter(|lock| lock.code_hash() == code_hash && lock.hash_type() == hash_type)
        .count();
    if comp_input_count != group_input_count {
        return Err(Error::MultipleLockGroups);
    }

    // Rule: exactly one successor output carrying a COMP lock (no fork).
    let successor_indexes: Vec<usize> = QueryIter::new(load_cell, Source::Output)
        .enumerate()
        .filter(|(_, cell)| {
            let lock = cell.lock();
            lock.code_hash() == code_hash && lock.hash_type() == hash_type
        })
        .map(|(i, _)| i)
        .collect();
    if successor_indexes.len() != 1 {
        return Err(Error::InvalidSuccessorCount);
    }
    let successor_index = successor_indexes[0];

    // Rule: neither the input nor the successor may carry a type script.
    if load_cell_type(0, Source::GroupInput)
        .map_err(|_| Error::Encoding)?
        .is_some()
    {
        return Err(Error::TypeScriptNotAllowed);
    }
    if load_cell_type(successor_index, Source::Output)
        .map_err(|_| Error::Encoding)?
        .is_some()
    {
        return Err(Error::TypeScriptNotAllowed);
    }

    let input_cell = load_cell(0, Source::GroupInput).map_err(|_| Error::Encoding)?;
    let successor_cell = load_cell(successor_index, Source::Output).map_err(|_| Error::Encoding)?;

    // Rule: lock preservation (code_hash, hash_type and args are all immutable).
    if input_cell.lock().as_slice() != successor_cell.lock().as_slice() {
        return Err(Error::LockMismatch);
    }

    // Rule: capacity protection with overflow-safe arithmetic.
    // Equivalent to `out_cap >= in_cap - max_fee`.
    let in_cap: u64 = input_cell.capacity().unpack();
    let out_cap: u64 = successor_cell.capacity().unpack();
    match out_cap.checked_add(max_fee) {
        Some(limit) => {
            if limit < in_cap {
                return Err(Error::CapacityExceeded);
            }
        }
        // out_cap + max_fee overflowed u64, so it is certainly >= in_cap.
        None => {}
    }

    // Cell data is unrestricted. Now verify the optional witness message.
    verify_message()
}

fn verify_message() -> Result<(), Error> {
    let witness = match load_witness_args(0, Source::GroupInput) {
        Ok(w) => w,
        // No witness slot at all: anonymous message.
        Err(SysError::ItemMissing) | Err(SysError::IndexOutOfBound) => return Ok(()),
        Err(_) => return Err(Error::WitnessFormat),
    };
    let message_bytes: Vec<u8> = match witness.lock().to_opt() {
        Some(lock) => lock.unpack(),
        None => return Ok(()),
    };
    if message_bytes.is_empty() {
        return Ok(());
    }
    let message = core::str::from_utf8(&message_bytes).map_err(|_| Error::WitnessFormat)?;
    let fields = json::parse_message(message)?;

    let (address, signature_hex) = match (fields.address, fields.signature) {
        (None, None) => return Ok(()),
        (Some(address), Some(signature)) => (address, signature),
        _ => return Err(Error::InvalidIdentity),
    };

    let extensions = fields.extensions.ok_or(Error::WitnessFormat)?;
    let signature = decode_hex(signature_hex)?;
    if signature.len() != ZERO_SIGNATURE_LEN {
        return Err(Error::WitnessFormat);
    }

    // canonical_encode(address, ZERO_SIGNATURE, extensions)
    let mut message_bytes =
        Vec::with_capacity(address.len() + ZERO_SIGNATURE_LEN + extensions.len());
    message_bytes.extend_from_slice(address.as_bytes());
    message_bytes.extend_from_slice(&[0u8; ZERO_SIGNATURE_LEN]);
    message_bytes.extend_from_slice(extensions.as_bytes());
    let message_hash = blake2b_256(&message_bytes);

    let tx_hash = load_tx_hash().map_err(|_| Error::Encoding)?;
    let mut digest_preimage = Vec::with_capacity(64);
    digest_preimage.extend_from_slice(&tx_hash);
    digest_preimage.extend_from_slice(&message_hash);
    let signing_digest = blake2b_256(&digest_preimage);

    let expected_lock_args = bech32::decode_lock_args(address)?;

    verify_secp256k1(&signing_digest, &signature, &expected_lock_args)
}

fn verify_secp256k1(digest: &[u8; 32], signature: &[u8], lock_args: &[u8]) -> Result<(), Error> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    let sig = Signature::from_slice(&signature[..64]).map_err(|_| Error::SignatureInvalid)?;
    let recid_byte = match signature[64] {
        v @ 27..=28 => v - 27,
        v @ 0..=3 => v,
        _ => return Err(Error::SignatureInvalid),
    };
    let recid = RecoveryId::try_from(recid_byte).map_err(|_| Error::SignatureInvalid)?;
    let verifying_key = VerifyingKey::recover_from_prehash(digest, &sig, recid)
        .map_err(|_| Error::SignatureInvalid)?;
    let compressed_pubkey = verifying_key.to_encoded_point(true);
    let pubkey_hash = blake2b_256(compressed_pubkey.as_bytes());
    if pubkey_hash[..20] != lock_args[..] {
        return Err(Error::SignatureInvalid);
    }
    Ok(())
}

fn decode_hex(s: &str) -> Result<Vec<u8>, Error> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        return Err(Error::WitnessFormat);
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_value(bytes[i])?;
        let lo = hex_value(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_value(c: u8) -> Result<u8, Error> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(Error::WitnessFormat),
    }
}
