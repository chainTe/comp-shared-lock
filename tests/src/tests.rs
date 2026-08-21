use ckb_hash::blake2b_256;
use ckb_testtool::context::Context;
use ckb_types::bytes::Bytes;
use ckb_types::core::TransactionBuilder;
use ckb_types::packed::*;
use ckb_types::prelude::*;
use k256::ecdsa::{SigningKey, VerifyingKey};

const MAX_CYCLES: u64 = 100_000_000;
const RELATIVE_BLOCK_SINCE_ONE: u64 = (1u64 << 63) | 1;
const ERROR_INVALID_SINCE: i8 = 16;

fn assert_rejected_with_code(
    context: &Context,
    tx: &ckb_types::core::TransactionView,
    exit_code: i8,
) {
    let error = context
        .verify_tx(tx, MAX_CYCLES)
        .expect_err("transaction must fail");
    let rendered = error.to_string();
    assert!(
        rendered.contains(&format!("ValidationFailure: see error code {exit_code}")),
        "expected exit code {exit_code}, got: {rendered}"
    );
}

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
    }
}

fn base_tx(fx: &Fixture, outputs: Vec<CellOutput>, outputs_data: Vec<Bytes>) -> TransactionBuilder {
    let contract_dep = CellDep::new_builder()
        .out_point(fx.contract_out_point.clone())
        .build();
    let input = CellInput::new_builder()
        .since(RELATIVE_BLOCK_SINCE_ONE.pack())
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
    let context = fx.context;
    let cycles = context.verify_tx(&tx, MAX_CYCLES).expect("pass");
    println!("cycles: {}", cycles);
}

#[test]
fn test_anonymous_with_extensions_message() {
    let fx = setup(2, 1_000_000, 100_0000_0000u64);
    let witness = WitnessArgs::new_builder()
        .lock(
            Some(Bytes::from(
                r#"{"extensions":{"protocol":"comp","version":2,"type":"text","payload":"hello"}}"#
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
    let context = fx.context;
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
    let context = fx.context;
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
    let context = fx.context;
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
    let context = fx.context;
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
                .since(RELATIVE_BLOCK_SINCE_ONE.pack())
                .previous_output(fx.input_out_point.clone())
                .build(),
        )
        .input(
            CellInput::new_builder()
                .since(RELATIVE_BLOCK_SINCE_ONE.pack())
                .previous_output(input_b_out_point)
                .build(),
        )
        .outputs(vec![
            successor_output(&fx.lock_script, 100_0000_0000u64),
            successor_output(&lock_b, 50_0000_0000u64),
        ])
        .outputs_data([Bytes::new(), Bytes::new()].pack())
        .build();
    let context = fx.context;
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
                .since(RELATIVE_BLOCK_SINCE_ONE.pack())
                .previous_output(fx.input_out_point.clone())
                .build(),
        )
        .input(
            CellInput::new_builder()
                .since(RELATIVE_BLOCK_SINCE_ONE.pack())
                .previous_output(input2_out_point)
                .build(),
        )
        .outputs(vec![successor_output(&fx.lock_script, 150_0000_0000u64)])
        .outputs_data([Bytes::new()].pack())
        .build();
    let context = fx.context;
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
    let context = fx.context;
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
    let context = fx.context;
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
    let context = fx.context;
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
    let context = fx.context;
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
                .since(RELATIVE_BLOCK_SINCE_ONE.pack())
                .previous_output(input_out_point)
                .build(),
        )
        .outputs(vec![successor_output(&lock_script, 100_0000_0000u64)])
        .outputs_data([Bytes::new()].pack())
        .build();
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_since_zero_rejected() {
    let fx = setup(14, 1_0000_0000u64, 100_0000_0000u64);
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
        .output(successor_output(&fx.lock_script, 100_0000_0000u64))
        .output_data(Bytes::new().pack())
        .build();
    let context = fx.context;
    assert_rejected_with_code(&context, &tx, ERROR_INVALID_SINCE);
}

#[test]
fn test_absolute_block_one_rejected() {
    let fx = setup(15, 1_0000_0000u64, 100_0000_0000u64);
    let contract_dep = CellDep::new_builder()
        .out_point(fx.contract_out_point.clone())
        .build();
    let tx = TransactionBuilder::default()
        .cell_dep(contract_dep)
        .input(
            CellInput::new_builder()
                .since(1u64.pack())
                .previous_output(fx.input_out_point.clone())
                .build(),
        )
        .output(successor_output(&fx.lock_script, 100_0000_0000u64))
        .output_data(Bytes::new().pack())
        .build();
    let context = fx.context;
    assert_rejected_with_code(&context, &tx, ERROR_INVALID_SINCE);
}

#[test]
fn test_relative_block_two_rejected() {
    let fx = setup(16, 1_0000_0000u64, 100_0000_0000u64);
    let contract_dep = CellDep::new_builder()
        .out_point(fx.contract_out_point.clone())
        .build();
    let tx = TransactionBuilder::default()
        .cell_dep(contract_dep)
        .input(
            CellInput::new_builder()
                .since(((1u64 << 63) | 2).pack())
                .previous_output(fx.input_out_point.clone())
                .build(),
        )
        .output(successor_output(&fx.lock_script, 100_0000_0000u64))
        .output_data(Bytes::new().pack())
        .build();
    let context = fx.context;
    assert_rejected_with_code(&context, &tx, ERROR_INVALID_SINCE);
}

// ---- signed message tests ----

fn test_signing_key(tag: u8) -> SigningKey {
    let mut bytes = [0u8; 32];
    bytes[31] = tag;
    SigningKey::from_bytes((&bytes).into()).expect("valid deterministic test key")
}

fn public_key_hex(signing_key: &SigningKey) -> String {
    let verifying_key: &VerifyingKey = signing_key.verifying_key();
    format!(
        "0x{}",
        hex::encode(verifying_key.to_encoded_point(true).as_bytes())
    )
}

fn sign_message(signing_key: &SigningKey, public_key: &str, tx_hash: &[u8; 32]) -> Bytes {
    let extensions =
        r#"{"protocol":"comp","version":2,"type":"text","payload":"hello signed world"}"#;
    let mut message_bytes = Vec::new();
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
        r#"{{"public_key":"{}","signature":"0x{}","extensions":{}}}"#,
        public_key,
        hex::encode(&sig_bytes),
        extensions
    );
    Bytes::from(witness_json.into_bytes())
}

#[test]
fn test_signed_message_public_key_success() {
    let fx = setup(20, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = test_signing_key(1);
    let public_key = public_key_hex(&signing_key);

    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 99_9999_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();

    let message = sign_message(&signing_key, &public_key, &tx_hash);
    let witness = WitnessArgs::new_builder()
        .lock(Some(message).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();

    let context = fx.context;
    let cycles = context.verify_tx(&tx, MAX_CYCLES).expect("pass");
    println!("signed message cycles: {}", cycles);
}

#[test]
fn test_signed_message_wrong_public_key_rejected() {
    let fx = setup(21, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = test_signing_key(2);
    let other_key = test_signing_key(3);
    let claimed_public_key = public_key_hex(&other_key);

    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();
    let message = sign_message(&signing_key, &claimed_public_key, &tx_hash);
    let witness = WitnessArgs::new_builder()
        .lock(Some(message).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();

    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_signed_message_tampered_payload_rejected() {
    let fx = setup(22, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = test_signing_key(4);
    let public_key = public_key_hex(&signing_key);

    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();

    let extensions = r#"{"protocol":"comp","version":2,"type":"text","payload":"original"}"#;
    let mut message_bytes = Vec::new();
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
        r#"{{"public_key":"{}","signature":"0x{}","extensions":{{"protocol":"comp","version":2,"type":"text","payload":"tampered"}}}}"#,
        public_key,
        hex::encode(&sig_bytes)
    );
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(tampered.into_bytes())).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();

    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_public_key_without_signature_rejected() {
    let fx = setup(23, 1_0000_0000u64, 100_0000_0000u64);
    let public_key = public_key_hex(&test_signing_key(5));
    let witness = WitnessArgs::new_builder()
        .lock(
            Some(Bytes::from(
                format!(
                    r#"{{"public_key":"{}","extensions":{{"protocol":"comp","version":2,"type":"text","payload":"hi"}}}}"#,
                    public_key
                )
                .into_bytes(),
            ))
            .pack(),
        )
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_signature_without_public_key_rejected() {
    let fx = setup(24, 1_0000_0000u64, 100_0000_0000u64);
    let witness = WitnessArgs::new_builder()
        .lock(
            Some(Bytes::from(
                format!(
                    r#"{{"signature":"0x{}","extensions":{{"protocol":"comp","version":2,"type":"text","payload":"hi"}}}}"#,
                    hex::encode([1u8; 65])
                )
                .into_bytes(),
            ))
            .pack(),
        )
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_uncompressed_public_key_rejected() {
    let fx = setup(25, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = test_signing_key(6);
    let public_key = format!(
        "0x{}",
        hex::encode(
            signing_key
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes()
        )
    );
    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();
    let message = sign_message(&signing_key, &public_key, &tx_hash);
    let witness = WitnessArgs::new_builder()
        .lock(Some(message).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();
    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_signature_invalid_bytes_rejected() {
    let fx = setup(26, 1_0000_0000u64, 100_0000_0000u64);
    let public_key = public_key_hex(&test_signing_key(7));
    let witness = WitnessArgs::new_builder()
        .lock(
            Some(Bytes::from(
                format!(
                    r#"{{"public_key":"{}","signature":"0x{}","extensions":{{"protocol":"comp","version":2,"type":"text","payload":"hi"}}}}"#,
                    public_key,
                    hex::encode([0u8; 65])
                )
                .into_bytes(),
            ))
            .pack(),
        )
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_legacy_address_field_rejected() {
    assert_message_rejected(
        30,
        &format!(
            r#"{{"address":"ckt1legacy","signature":"0x{}","extensions":{{"protocol":"comp","version":2,"type":"text","payload":"hi"}}}}"#,
            hex::encode([1u8; 65])
        ),
    );
}

#[test]
fn test_duplicate_public_key_field_rejected() {
    let fx = setup(31, 1_0000_0000u64, 100_0000_0000u64);
    let signing_key = test_signing_key(8);
    let public_key = public_key_hex(&signing_key);
    let tx_without_witness = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .build();
    let tx_hash: [u8; 32] = tx_without_witness.hash().unpack();
    let canonical = String::from_utf8(sign_message(&signing_key, &public_key, &tx_hash).to_vec())
        .expect("message utf8");
    let duplicate = format!(r#"{{"public_key":"{}",{}"#, public_key, &canonical[1..]);
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(duplicate.into_bytes())).pack())
        .build();
    let tx = tx_without_witness
        .as_advanced_builder()
        .witness(witness.as_bytes().pack())
        .build();

    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

fn assert_message_rejected(tag: u8, message: &str) {
    let fx = setup(tag, 1_0000_0000u64, 100_0000_0000u64);
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(message.as_bytes().to_vec())).pack())
        .build();
    let tx = base_tx(
        &fx,
        vec![successor_output(&fx.lock_script, 100_0000_0000u64)],
        vec![Bytes::new()],
    )
    .witness(witness.as_bytes().pack())
    .build();
    let context = fx.context;
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn test_trailing_json_bytes_rejected() {
    assert_message_rejected(32, "{}trailing");
}

#[test]
fn test_wrong_identity_json_type_rejected() {
    assert_message_rejected(33, r#"{"public_key":false}"#);
}

#[test]
fn test_wrong_extensions_json_type_rejected() {
    assert_message_rejected(34, r#"{"extensions":1}"#);
}

#[test]
fn test_malformed_nested_extensions_rejected() {
    assert_message_rejected(35, r#"{"extensions":{"items":[1,]}}"#);
}
