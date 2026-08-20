use ckb_hash::blake2b_256;
use ckb_testtool::context::Context;
use ckb_types::bytes::Bytes;
use ckb_types::core::TransactionBuilder;
use ckb_types::packed::*;
use ckb_types::prelude::*;
use k256::ecdsa::{SigningKey, VerifyingKey};

const MAX_CYCLES: u64 = 100_000_000;

fn deploy_contract(context: &mut Context) -> (OutPoint, Byte32) {
    let contract_bin: Bytes = std::fs::read("../build/release/comp-shared-lock")
        .expect("read contract binary")
        .into();
    let out_point = context.deploy_cell(contract_bin);
    let code_hash = context.get_cell(&out_point).unwrap().0.calc_lock_hash();
    (out_point, code_hash)
}

fn comp_args(tag: u8, max_fee: u64) -> Bytes {
    let mut args = vec![tag; 32];
    args.extend_from_slice(&max_fee.to_le_bytes());
    args.into()
}

struct Fixture {
    context: Context,
    contract_out_point: OutPoint,
    lock_script: Script,
    input_out_point: OutPoint,
    input_capacity: u64,
}

fn setup(tag: u8, max_fee: u64, input_capacity: u64) -> Fixture {
    let mut context = Context::default();
    let (contract_out_point, _) = deploy_contract(&mut context);
    let lock_script = context
        .build_script(&contract_out_point, comp_args(tag, max_fee))
        .expect("build script");
    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(input_capacity.pack())
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );
    Fixture {
        context,
        contract_out_point,
        lock_script,
        input_out_point,
        input_capacity,
    }
}

fn base_tx(fx: &Fixture, outputs: Vec<CellOutput>, outputs_data: Vec<Bytes>) -> TransactionBuilder {
    let contract_dep = CellDep::new_builder()
        .out_point(fx.contract_out_point.clone())
        .build();
    let input = CellInput::new_builder()
        .previous_output(fx.input_out_point.clone())
        .build();
    TransactionBuilder::default()
        .cell_dep(contract_dep)
        .input(input)
        .outputs(outputs)
        .outputs_data(outputs_data.pack())
}

fn successor_output(lock: &Script, capacity: u64) -> CellOutput {
    CellOutput::new_builder()
        .capacity(capacity.pack())
        .lock(lock.clone())
        .build()
}

#[test]
fn test_anonymous_no_witness() {
    let fx = setup(1, 1_000_000, 100_0000_0000u64);
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let mut context = fx.context;
    let cycles = context.verify_tx(&tx, MAX_CYCLES).expect("pass");
    println!("cycles: {}", cycles);
}

#[test]
fn test_anonymous_with_extensions_message() {
    let fx = setup(2, 1_000_000, 100_0000_0000u64);
    let witness = WitnessArgs::new_builder()
        .lock(
            Some(Bytes::from(
                r#"{"extensions":{"protocol":"comp","version":1,"type":"text","payload":"hello"}}"#
                    .as_bytes()
                    .to_vec(),
            ))
            .pack(),
        )
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 99_9999_0000u64)],
        vec![Bytes::from(b"hello".to_vec())],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let mut context = fx.context;
    context.verify_tx(&tx, MAX_CYCLES).expect("pass");
}

#[test]
fn test_capacity_drop_within_max_fee() {
    let fx = setup(3, 1_0000_0000u64, 100_0000_0000u64);
    // drop exactly max_fee
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 99_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let mut context = fx.context;
    context.verify_tx(&tx, MAX_CYCLES).expect("pass");
}

#[test]
fn test_capacity_drop_beyond_max_fee() {
    let fx = setup(4, 1_0000_0000u64, 100_0000_0000u64);
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 98_9999_9999u64)],
        vec![Bytes::new()],
    )
    .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_sponsoring_capacity_increase() {
    let fx = setup(5, 1_0000_0000u64, 100_0000_0000u64);
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 500_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let mut context = fx.context;
    context.verify_tx(&tx, MAX_CYCLES).expect("pass");
}

#[test]
fn test_two_comp_lock_groups_rejected() {
    let mut fx = setup(6, 1_0000_0000u64, 100_0000_0000u64);
    // second COMP cell with different args -> different lock group
    let lock_b = fx
        .context
        .build_script(&fx.contract_out_point, comp_args(7, 1_0000_0000u64))
        .unwrap();
    let input_b_out_point = fx.context.create_cell(
        CellOutput::new_builder()
            .capacity(50_0000_0000u64.pack())
            .lock(lock_b.clone())
            .build(),
        Bytes::new(),
    );
    let contract_dep = CellDep::new_builder()
        .out_point(fx.contract_out_point.clone())
        .build();
    let tx = TransactionBuilder::default()
        .cell_dep(contract_dep)
        .input(
            CellInput::new_builder()
                .previous_output(fx.input_out_point.clone())
                .build(),
        )
        .input(
            CellInput::new_builder()
                .previous_output(input_b_out_point)
                .build(),
        )
        .outputs(vec![
            successor_output(&fx.lock_script, 100_0000_0000u64),
            successor_output(&lock_b, 50_0000_0000u64),
        ])
        .outputs_data(vec![Bytes::new(), Bytes::new()].pack())
        .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_merge_inputs_rejected() {
    let mut fx = setup(8, 1_0000_0000u64, 100_0000_0000u64);
    let input2_out_point = fx.context.create_cell(
        CellOutput::new_builder()
            .capacity(50_0000_0000u64.pack())
            .lock(fx.lock_script.clone())
            .build(),
        Bytes::new(),
    );
    let contract_dep = CellDep::new_builder()
        .out_point(fx.contract_out_point.clone())
        .build();
    let tx = TransactionBuilder::default()
        .cell_dep(contract_dep)
        .input(
            CellInput::new_builder()
                .previous_output(fx.input_out_point.clone())
                .build(),
        )
        .input(
            CellInput::new_builder()
                .previous_output(input2_out_point)
                .build(),
        )
        .outputs(vec![successor_output(&fx.lock_script, 150_0000_0000u64)])
        .outputs_data(vec![Bytes::new()].pack())
        .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_fork_outputs_rejected() {
    let fx = setup(9, 1_0000_0000u64, 100_0000_0000u64);
    let tx = base_tx(
        &fx,
        vec![
            successor_output(&fx.lock_script, 60_0000_0000u64),
            successor_output(&fx.lock_script, 40_0000_0000u64),
        ],
        vec![Bytes::new(), Bytes::new()],
    )
    .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_no_successor_rejected() {
    let fx = setup(10, 1_0000_0000u64, 100_0000_0000u64);
    let other_lock = Script::new_builder()
        .code_hash([9u8; 32].pack())
        .hash_type(ckb_types::core::ScriptHashType::Data2.into())
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&other_lock, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_type_script_rejected() {
    let fx = setup(11, 1_0000_0000u64, 100_0000_0000u64);
    let type_script = Script::new_builder()
        .code_hash([8u8; 32].pack())
        .hash_type(ckb_types::core::ScriptHashType::Data2.into())
        .build();
    let output = CellOutput::new_builder()
        .capacity(100_0000_0000u64.pack())
        .lock(fx.lock_script.clone())
        .type_(Some(type_script).pack())
        .build();
    let tx = base_tx(&fx, vec![output], vec![Bytes::new()]).build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_lock_args_mutation_rejected() {
    let mut fx = setup(12, 1_0000_0000u64, 100_0000_0000u64);
    let mutated_lock = fx
        .context
        .build_script(&fx.contract_out_point, comp_args(13, 1_0000_0000u64))
        .unwrap();
    let tx = base_tx(
        &fx,
        vec![successor_output(&mutated_lock, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_bad_args_length_rejected() {
    let mut context = Context::default();
    let (contract_out_point, _) = deploy_contract(&mut context);
    let bad_args: Bytes = vec![1u8; 39].into();
    let lock_script = context
        .build_script(&contract_out_point, bad_args)
        .expect("build script");
    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_0000_0000u64.pack())
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );
    let contract_dep = CellDep::new_builder().out_point(contract_out_point).build();
    let tx = TransactionBuilder::default()
        .cell_dep(contract_dep)
        .input(
            CellInput::new_builder()
                .previous_output(input_out_point)
                .build(),
        )
        .outputs(vec![successor_output(&lock_script, 100_0000_0000u64)])
        .outputs_data(vec![Bytes::new()].pack())
        .build();
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

// ---- signed message tests ----

fn blake160(data: &[u8]) -> [u8; 20] {
    let h = blake2b_256(data);
    let mut out = [0u8; 20];
    out.copy_from_slice(&h[..20]);
    out
}

const BECH32M_CONST: u32 = 0x2bc830a3;
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
    v.push(0);
    v.extend(hrp.bytes().map(|c| c & 31));
    v
}

fn polymod(values: &[u8]) -> u32 {
    let mut chk: u32 = 1;
    const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    for &v in values {
        let top = chk >> 25;
        chk = (chk & 0x1ffffff) << 5 ^ (v as u32);
        for i in 0..5 {
            if (top >> i) & 1 == 1 {
                chk ^= GEN[i];
            }
        }
    }
    chk
}

fn convert_bits_8_to_5(data: &[u8]) -> Vec<u8> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    for &value in data {
        acc = (acc << 8) | value as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        out.push(((acc << (5 - bits)) & 31) as u8);
    }
    out
}

fn bech32m_encode(hrp: &str, payload: &[u8]) -> String {
    let data5 = convert_bits_8_to_5(payload);
    let mut values = hrp_expand(hrp);
    values.extend(&data5);
    values.extend([0u8; 6]);
    let pm = polymod(&values) ^ BECH32M_CONST;
    let mut out = String::new();
    out.push_str(hrp);
    out.push('1');
    for &d in &data5 {
        out.push(CHARSET[d as usize] as char);
    }
    for i in 0..6 {
        out.push(CHARSET[((pm >> (5 * (5 - i))) & 31) as usize] as char);
    }
    out
}

fn test_address_for_key(signing_key: &SigningKey) -> String {
    let verifying_key: &VerifyingKey = signing_key.verifying_key();
    let compressed = verifying_key.to_encoded_point(true);
    let args = blake160(compressed.as_bytes());
    // CCC-style compact full address payload: 0x00 || code_hash(32) || hash_type(1) || args(20)
    let mut payload = vec![0x00u8];
    payload.extend_from_slice(&[0x9bu8; 32]);
    payload.push(0x00);
    payload.extend_from_slice(&args);
    bech32m_encode("ckt", &payload)
}

fn molecule_address_for_key(signing_key: &SigningKey) -> String {
    let verifying_key: &VerifyingKey = signing_key.verifying_key();
    let compressed = verifying_key.to_encoded_point(true);
    let args = blake160(compressed.as_bytes());
    let script = Script::new_builder()
        .code_hash([0x9bu8; 32].pack())
        .hash_type(ckb_types::core::ScriptHashType::Data1.into())
        .args(Bytes::from(args.to_vec()).pack())
        .build();
    bech32m_encode("ckt", script.as_slice())
}

fn sign_message(signing_key: &SigningKey, address: &str, tx_hash: &[u8; 32]) -> Bytes {
    let extensions =
        r#"{"protocol":"comp","version":1,"type":"text","payload":"hello signed world"}"#;
    let mut message_bytes = Vec::new();
    message_bytes.extend_from_slice(address.as_bytes());
    message_bytes.extend_from_slice(&[0u8; 65]);
    message_bytes.extend_from_slice(extensions.as_bytes());
    let message_hash = blake2b_256(&message_bytes);
    let mut preimage = Vec::new();
    preimage.extend_from_slice(tx_hash);
    preimage.extend_from_slice(&message_hash);
    let digest = blake2b_256(&preimage);
    let (sig, recid) = signing_key.sign_prehash_recoverable(&digest).expect("sign");
    let mut sig_bytes = sig.to_bytes().to_vec();
    sig_bytes.push(recid.to_byte());
    let witness_json = format!(
        r#"{{"address":"{}","signature":"0x{}","extensions":{}}}"#,
        address,
        hex::encode(&sig_bytes),
        extensions
    );
    Bytes::from(witness_json.into_bytes())
}

#[test]
fn test_signed_message_success() {
    let fx = setup(20, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = SigningKey::random(&mut rand::rngs::OsRng);
    let address = test_address_for_key(&signing_key);

    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 99_9999_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();

    let message = sign_message(&signing_key, &address, &tx_hash);
    let witness = WitnessArgs::new_builder()
        .lock(Some(message).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();

    let mut context = fx.context;
    let cycles = context.verify_tx(&tx, MAX_CYCLES).expect("pass");
    println!("signed message cycles: {}", cycles);
}

#[test]
fn test_signed_message_wrong_signer_rejected() {
    let fx = setup(21, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = SigningKey::random(&mut rand::rngs::OsRng);
    let other_key = SigningKey::random(&mut rand::rngs::OsRng);
    let address = test_address_for_key(&other_key);

    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();
    // signed by signing_key but claims other_key's address
    let message = sign_message(&signing_key, &address, &tx_hash);
    let witness = WitnessArgs::new_builder()
        .lock(Some(message).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();

    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_signed_message_tampered_payload_rejected() {
    let fx = setup(22, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = SigningKey::random(&mut rand::rngs::OsRng);
    let address = test_address_for_key(&signing_key);

    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();

    // sign one payload, then tamper with the extensions in the witness
    let extensions = r#"{"protocol":"comp","version":1,"type":"text","payload":"original"}"#;
    let mut message_bytes = Vec::new();
    message_bytes.extend_from_slice(address.as_bytes());
    message_bytes.extend_from_slice(&[0u8; 65]);
    message_bytes.extend_from_slice(extensions.as_bytes());
    let message_hash = blake2b_256(&message_bytes);
    let mut preimage = Vec::new();
    preimage.extend_from_slice(&tx_hash);
    preimage.extend_from_slice(&message_hash);
    let digest = blake2b_256(&preimage);
    let (sig, recid) = signing_key.sign_prehash_recoverable(&digest).expect("sign");
    let mut sig_bytes = sig.to_bytes().to_vec();
    sig_bytes.push(recid.to_byte());
    let tampered = format!(
        r#"{{"address":"{}","signature":"0x{}","extensions":{{"protocol":"comp","version":1,"type":"text","payload":"tampered"}}}}"#,
        address,
        hex::encode(&sig_bytes)
    );
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(tampered.into_bytes())).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();

    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_address_without_signature_rejected() {
    let fx = setup(23, 1_0000_0000u64, 100_0000_0000u64);
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(
            r#"{"address":"ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqw55dvxd8p25k6q2xr99w42lqzgu8gc3yqmgdt78","extensions":{"protocol":"comp","version":1,"type":"text","payload":"hi"}}"#
                .as_bytes()
                .to_vec(),
        )).pack())
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_signature_without_address_rejected() {
    let fx = setup(24, 1_0000_0000u64, 100_0000_0000u64);
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(
            format!(
                r#"{{"signature":"0x{}","extensions":{{"protocol":"comp","version":1,"type":"text","payload":"hi"}}}}"#,
                hex::encode([1u8; 65])
            )
            .into_bytes(),
        )).pack())
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_signed_message_molecule_address_success() {
    let fx = setup(26, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = SigningKey::random(&mut rand::rngs::OsRng);
    let address = molecule_address_for_key(&signing_key);

    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();
    let message = sign_message(&signing_key, &address, &tx_hash);
    let witness = WitnessArgs::new_builder()
        .lock(Some(message).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();
    let mut context = fx.context;
    context.verify_tx(&tx, MAX_CYCLES).expect("pass");
}

#[test]
fn test_signature_invalid_bytes_rejected() {
    let fx = setup(25, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = SigningKey::random(&mut rand::rngs::OsRng);
    let address = test_address_for_key(&signing_key);
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(
            format!(
                r#"{{"address":"{}","signature":"0x{}","extensions":{{"protocol":"comp","version":1,"type":"text","payload":"hi"}}}}"#,
                address,
                hex::encode([0u8; 65])
            )
            .into_bytes(),
        )).pack())
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let mut context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}
