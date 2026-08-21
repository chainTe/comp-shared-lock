#![no_std]
#![no_main]

mod json;

use core::convert::TryInto;

use ckb_hash::new_blake2b;
use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::prelude::*;
use ckb_std::default_alloc;
use ckb_std::entry;
use ckb_std::error::SysError;
use ckb_std::high_level::{
    load_cell_capacity, load_cell_lock, load_cell_type, load_input_since, load_script,
    load_tx_hash, load_witness_args, QueryIter,
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
    // Exactly one of public_key / signature is present
    InvalidIdentity,
    // Witness message cannot be parsed
    WitnessFormat,
    // Signature verification failed
    SignatureInvalid,
    // The COMP input must use relative block-number since = 1
    InvalidSince,
}

const ZERO_SIGNATURE_LEN: usize = 65;
const ZERO_SIGNATURE: [u8; ZERO_SIGNATURE_LEN] = [0u8; ZERO_SIGNATURE_LEN];
const COMPRESSED_PUBLIC_KEY_LEN: usize = 33;
const RELATIVE_BLOCK_SINCE_ONE: u64 = (1u64 << 63) | 1;

fn program_entry() -> i8 {
    #[cfg(feature = "enable_log")]
    let _ = ckb_std::logger::init();

    match verify() {
        Ok(()) => {
            #[cfg(feature = "enable_log")]
            log::debug!("COMP shared lock verification succeeded");
            0
        }
        Err(err) => {
            #[cfg(feature = "enable_log")]
            log::debug!("COMP shared lock verification failed: {}", err as i8);
            err as i8
        }
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script().map_err(|_| Error::Encoding)?;
    let args = script.args().raw_data();
    if args.len() != 40 {
        return Err(Error::ArgsEncoding);
    }
    let max_fee = u64::from_le_bytes(args[32..40].try_into().map_err(|_| Error::ArgsEncoding)?);

    let code_hash = script.code_hash();
    let hash_type = script.hash_type();

    // Rule: the lock group must contain exactly one input cell (no merge).
    // Load only lock fields instead of allocating complete CellOutput values.
    let mut group_inputs = QueryIter::new(load_cell_lock, Source::GroupInput);
    let input_lock = group_inputs.next().ok_or(Error::InvalidInputCount)?;
    if group_inputs.next().is_some() {
        return Err(Error::InvalidInputCount);
    }

    // Require the successor chain to advance by at least one committed block.
    // Exact encoding also rejects absolute height 1 and other since metrics.
    let since = load_input_since(0, Source::GroupInput).map_err(|_| Error::Encoding)?;
    if since != RELATIVE_BLOCK_SINCE_ONE {
        return Err(Error::InvalidSince);
    }

    // Rule: only one COMP lock group may exist in the whole transaction.
    let comp_input_count = QueryIter::new(load_cell_lock, Source::Input)
        .filter(|lock| lock.code_hash() == code_hash && lock.hash_type() == hash_type)
        .count();
    if comp_input_count != 1 {
        return Err(Error::MultipleLockGroups);
    }

    // Rule: exactly one successor output carrying a COMP lock (no fork).
    let mut successor = None;
    for (index, lock) in QueryIter::new(load_cell_lock, Source::Output).enumerate() {
        if lock.code_hash() == code_hash
            && lock.hash_type() == hash_type
            && successor.replace((index, lock)).is_some()
        {
            return Err(Error::InvalidSuccessorCount);
        }
    }
    let (successor_index, successor_lock) = successor.ok_or(Error::InvalidSuccessorCount)?;

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

    // Rule: lock preservation (code_hash, hash_type and args are all immutable).
    if input_lock.as_slice() != successor_lock.as_slice() {
        return Err(Error::LockMismatch);
    }

    // Rule: capacity protection with overflow-safe arithmetic.
    // Equivalent to `out_cap >= in_cap - max_fee`.
    let in_cap = load_cell_capacity(0, Source::GroupInput).map_err(|_| Error::Encoding)?;
    let out_cap =
        load_cell_capacity(successor_index, Source::Output).map_err(|_| Error::Encoding)?;
    // If addition overflows, the mathematical result is certainly >= in_cap.
    if out_cap
        .checked_add(max_fee)
        .is_some_and(|limit| limit < in_cap)
    {
        return Err(Error::CapacityExceeded);
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
    let message_bytes = match witness.lock().to_opt() {
        Some(lock) => lock.raw_data(),
        None => return Ok(()),
    };
    if message_bytes.is_empty() {
        return Ok(());
    }
    let message = core::str::from_utf8(&message_bytes).map_err(|_| Error::WitnessFormat)?;
    let fields = json::parse_message(message)?;

    let (public_key_hex, signature_hex) = match (fields.public_key, fields.signature) {
        (None, None) => return Ok(()),
        (Some(public_key), Some(signature)) => (public_key, signature),
        _ => return Err(Error::InvalidIdentity),
    };

    let extensions = fields.extensions.ok_or(Error::WitnessFormat)?;
    let public_key = decode_fixed_hex::<COMPRESSED_PUBLIC_KEY_LEN>(public_key_hex)?;
    let signature = decode_fixed_hex::<ZERO_SIGNATURE_LEN>(signature_hex)?;

    // canonical_encode(ZERO_SIGNATURE, extensions). The public key is bound by
    // equality with the key recovered from the resulting signature, so it does
    // not need to participate in the digest and can be discovered after signing.
    // Hash incrementally so witness size does not cause a second proportional
    // heap allocation inside the 4 MiB CKB-VM memory limit.
    let mut message_hasher = new_blake2b();
    message_hasher.update(&ZERO_SIGNATURE);
    message_hasher.update(extensions.as_bytes());
    let mut message_hash = [0u8; 32];
    message_hasher.finalize(&mut message_hash);

    let tx_hash = load_tx_hash().map_err(|_| Error::Encoding)?;
    let mut digest_hasher = new_blake2b();
    digest_hasher.update(&tx_hash);
    digest_hasher.update(&message_hash);
    let mut signing_digest = [0u8; 32];
    digest_hasher.finalize(&mut signing_digest);

    verify_secp256k1(&signing_digest, &signature, &public_key)
}

fn verify_secp256k1(
    digest: &[u8; 32],
    signature: &[u8; ZERO_SIGNATURE_LEN],
    public_key: &[u8; COMPRESSED_PUBLIC_KEY_LEN],
) -> Result<(), Error> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    let sig = Signature::from_slice(&signature[..64]).map_err(|_| Error::SignatureInvalid)?;
    let recid_byte = match signature[64] {
        v @ 27..=28 => v - 27,
        v @ 0..=3 => v,
        _ => return Err(Error::SignatureInvalid),
    };
    let recid = RecoveryId::try_from(recid_byte).map_err(|_| Error::SignatureInvalid)?;
    let recovered_key = VerifyingKey::recover_from_prehash(digest, &sig, recid)
        .map_err(|_| Error::SignatureInvalid)?;
    if recovered_key.to_encoded_point(true).as_bytes() != public_key {
        return Err(Error::SignatureInvalid);
    }
    Ok(())
}

fn decode_fixed_hex<const N: usize>(s: &str) -> Result<[u8; N], Error> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != N * 2 {
        return Err(Error::WitnessFormat);
    }
    let bytes = s.as_bytes();
    let mut out = [0u8; N];
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_value(bytes[i])?;
        let lo = hex_value(bytes[i + 1])?;
        out[i / 2] = (hi << 4) | lo;
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
