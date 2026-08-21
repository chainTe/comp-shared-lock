# COMP Shared Lock v0.3 Contract Design

This document fixes the interface and validation rules implemented by
`contracts/comp-shared-lock`. Amounts are in shannons and integers use little
endian encoding unless stated otherwise.

## Contract type and protected cell model

`comp-shared-lock` is a **lock on-chain script**. A protected COMP cell must not
have a type on-chain script. Its cell data is application-owned opaque bytes;
the lock validates the cell's continuity and optional message witness, not the
data schema.

| Field | Input COMP cell | Successor COMP cell |
| --- | --- | --- |
| `capacity` | Any valid occupied capacity | At least `input_capacity - max_fee`; may increase |
| `lock` | COMP `Script` below | Byte-identical to the input lock |
| `type` | Absent | Absent |
| `data` | Opaque | Opaque; may change |

The protected cell appears once as an input and once as a successor output in
every valid transition. Creation of the initial cell is outside this lock's
execution because an output lock does not execute until the cell is consumed.

## Lock args

The lock `Script.args` is exactly 40 bytes:

```text
offset  size  field
0       32    channel_hash: Byte32
32      8     max_fee: u64 little-endian
```

`channel_hash` identifies application state and is opaque to the lock.
`max_fee` bounds how much capacity the COMP cell may lose in one transition.
Both fields are immutable because the complete successor lock `Script` must be
byte-identical to the input lock. Example: `11…11` (32 bytes) followed by
`40420f0000000000` encodes a channel hash of repeated `0x11` and a maximum loss
of 1,000,000 shannons.

## Witness schema and signing

Only the first witness in the COMP input script group is read. It must be a
Molecule `WitnessArgs`; the payload, when present, is in `WitnessArgs.lock` as
UTF-8 JSON. `input_type` and `output_type` are ignored by this lock.

```json
{
  "public_key": "0x<33-byte compressed secp256k1 public key or null>",
  "signature": "0x<65-byte recoverable secp256k1 signature or null>",
  "extensions": {"protocol":"comp","version":2}
}
```

No witness, an absent/empty `lock`, or both identity fields absent/null is an
anonymous message. `public_key` and `signature` must otherwise both be present,
unique, and strings; `extensions` must be a unique JSON object or array. JSON
must be complete (no trailing bytes). The public key uses compressed SEC1 form
(`0x02` or `0x03` plus 32-byte x-coordinate) and is independent of CKB addresses.
Unknown top-level fields are ignored after syntactic validation.

This is the COMP v0.2 witness schema. The former v0.1 `address` field is not an
authorization input and a legacy `address + signature` witness is rejected by
the v0.2 on-chain script. Off-chain readers may retain legacy parsing only for
displaying historical transactions.

For a signed message:

```text
message_hash   = CKB_BLAKE2B(65 zero bytes || raw_json(extensions))
signing_digest = CKB_BLAKE2B(tx_hash || message_hash)
signature      = compact r[32] || s[32] || recovery_id[1]
```

Recovery IDs `0..=3` and Ethereum-style `27..=28` are accepted. The recovered
compressed public key must exactly equal `public_key`. The raw transaction hash
commits to inputs, outputs, outputs data, cell/header deps and `since`; the
message hash commits to the extension payload, while recovery equality binds
the supplied public key to the signature. This avoids a public-key discovery
cycle for wallet signers and removes all CKB address/network dependencies.

## Script grouping and strict execution flow

CKB groups inputs by the complete lock `Script` hash. This lock executes once
for its group and performs these checks in order:

1. Load the current `Script` using `ckb-std` and decode the 40-byte args.
2. Require exactly one `Source::GroupInput` cell.
3. Require the group input's `since` to equal relative block-number one,
   encoded as `0x8000000000000001`.
4. Scan `Source::Input` locks and require that no other input uses the same
   COMP `code_hash` and `hash_type` with different args.
5. Scan output locks and require exactly one output using that COMP code and
   hash type.
6. Require the input and successor `type` fields to be absent.
7. Require the input and successor lock bytes to match exactly.
8. Load capacities directly and require
   `successor_capacity + max_fee >= input_capacity` using checked arithmetic.
9. Parse the group witness with the generated `WitnessArgs` type. Anonymous
   messages finish successfully; signed messages follow the public-key rules above.

Every parse, syscall, identity, continuity, capacity, or signature failure
terminates script execution with a non-zero contract error code.

## Transaction invariants

- `inputs`: exactly one COMP group input; no second input may use the same COMP
  code hash and hash type.
- `outputs`: exactly one successor using the COMP code hash and hash type, with
  identical lock bytes and no type on-chain script.
- `outputs_data`: one entry per output; the COMP entry is opaque to this lock.
- `cell_deps`: include the COMP code cell as `dep_type: code` (or a dep group
  containing it). Any other executed locks/types need their own deps.
- `header_deps`: none required by this lock.
- `since`: the COMP group input must be exactly relative block-number one:
  `0x8000000000000001`. Raw `0x1` is absolute block 1 and is rejected. This
  makes a COMP Cell created in block `H` first spendable in block `H + 1`.
- Fee/change: CKB still requires total input capacity to cover total output
  capacity and the transaction fee. The COMP successor's loss is independently
  bounded by `max_fee`; sponsor inputs and ordinary change outputs are allowed.

## State transitions and transaction samples

| Scenario | COMP inputs | COMP outputs | Witness | Result |
| --- | ---: | ---: | --- | --- |
| Anonymous update | 1 | 1 identical lock | Missing/empty/anonymous | Pass |
| Signed update | 1 | 1 identical lock | Valid signed JSON | Pass |
| Sponsor | 1 plus sponsor input | 1 with increased capacity | Any valid form | Pass |
| Merge/fork/consume | 0, 2, or 1 | 1, 2, or 0 | Any | Fail |
| Lock/type mutation | 1 | 1 mutated or typed | Any | Fail |
| Excessive loss | 1 | 1 | Any | Fail |
| Wrong `since` (`0`, absolute `1`, relative `2`, or another metric) | 1 | 1 | Any | Fail |
| Malformed/ambiguous identity | 1 | 1 | Bad Molecule/JSON/public key/signature | Fail |

Representative anonymous update:

```yaml
cell_deps: [{out_point: COMP_CODE_OUT_POINT, dep_type: code}]
inputs:
  - {previous_output: COMP_CELL_N, since: 0x8000000000000001}
outputs:
  - {capacity: INPUT_CAPACITY - FEE, lock: COMP_LOCK, type: null}
outputs_data: [NEXT_APPLICATION_DATA]
witnesses:
  - WitnessArgs.lock: null
expected_scripts: [COMP_LOCK]
expected: pass when FEE <= max_fee
negative: use FEE = max_fee + 1; expect CapacityExceeded
```

Representative signed update adds the JSON payload above to
`witnesses[COMP_GROUP_FIRST].lock`; a wrong public key, signer, transaction hash,
or extension payload fails. A sponsor transaction adds a normal-lock input and
change output plus that lock's signature witness; the COMP successor may exceed
its input capacity. Missing the COMP code `cell_dep` prevents script loading and
the transaction fails before contract validation.

## Security and resource notes

- The deployed code cell carries a singleton Type ID script. COMP locks use the
  Type ID script hash as `code_hash` with `hash_type: type`; transactions still
  pin the current live code-cell out point in `cell_deps`.
- Exact public-key length/encoding and duplicate-field checks prevent parser differentials.
- Hashing is incremental and signatures decode into a fixed 65-byte buffer, so
  witness size does not cause a proportional second allocation.
- Lock preservation prevents args replay into another channel; `tx_hash` binds a
  signature to one raw transaction. Witnesses belonging to unrelated locks are
  outside this lock's authorization boundary.
- The one-input/one-successor rule prevents merge, fork, and intentional
  destruction. The per-transition capacity bound does not impose a lifetime
  withdrawal limit; deployments must choose `max_fee` accordingly.
- Relative block `since = 1` limits each individual COMP Cell lineage to at
  most one transition in a block. Separate live COMP Cells remain independent;
  this is not a global per-block quota across all channels or Cells.
- The RISC-V binary is built with the pinned CKB Rust toolchain and measured in
  tests. Keep the final binary below the CKB approximately 500 KiB code-cell
  limit and review any result above 400 KiB.
