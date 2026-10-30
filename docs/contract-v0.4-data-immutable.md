# COMP Shared Lock v0.4 — Immutable Cell Data

Status: draft. Extends `docs/contract-design.md` (v0.3). One new rule; everything else is unchanged.

## 1. Contract type list

| on-chain script | kind | paired type on-chain script |
| --- | --- | --- |
| `comp-shared-lock` | **lock** | **forbidden** on the protected cell (`.type().is_some()` → `TypeScriptNotAllowed`) |

The v0.4 lock neither requires nor permits a type on-chain script on the cells it protects; application state lives entirely in the cell data and in witness messages.

## 2. Protected cell model

| Field | Input COMP cell | Successor COMP cell |
| --- | --- | --- |
| `lock` | COMP `Script` (40-byte args) | byte-identical to input (§5) |
| `type` | absent | absent |
| `data` | application bytes | **byte-identical to input** (new in v0.4) |
| `capacity` | any valid occupied capacity | ≥ `input_capacity - max_fee`; may increase (sponsoring) |

Creation of the first cell is not executed by this lock (outputs do not run), so the creator writes `data` freely. From the first spend onward, `data` is frozen.

## 3. Args schema

Unchanged from v0.3 — 40 bytes, little endian:

```
offset size field
0      32   channel_hash: Byte32   // identical to v0.3 derivation, see §9
32     8    max_fee: u64 LE        // max capacity loss per transition, shannons
```

`args` are immutable because the successor lock must be byte-identical (§5). v0.4 adds no flag and no new field, so a v0.4 cell is indistinguishable from a v0.3 cell by `args` alone — the difference is the code hash of the deployed script.

## 4. Witness schema

Unchanged. Only witness #0 of the COMP input script group is read; the payload, when present, is UTF-8 JSON inside `WitnessArgs.lock`:

```json
{ "public_key": "0x<33B compressed secp256k1 or null>", "signature": "0x<65B recoverable or null>", "extensions": { } }
```

- no witness, empty `lock`, or both identity fields absent/null → anonymous message
- exactly one of the two present → `InvalidIdentity`
- both present → secp256k1 recover over `blake2b_256(tx_hash ‖ blake2b_256(0x00*65 ‖ utf8(canonical_json(extensions))))`

Message content is not validated by the lock; applications put whatever they need in `extensions`.

## 5. Execution group rules

CKB groups inputs by their lock `Script` hash. For the COMP group:

- exactly 1 input cell (merge forbidden)
- exactly 1 successor output carrying the same COMP lock (fork forbidden)
- only witness #0 of that group input is inspected (`Source::GroupInput`, index 0)
- all cells are in `Source::Input` / `Source::Output`, no `header_deps` required

## 6. Strict execution flow

```
 1. load_script(); args.len() == 40                     else ArgsEncoding
 2. group inputs count == 1                             else InvalidInputCount
 3. input_since == 0x8000000000000001                   else InvalidSince
 4. COMP inputs over whole tx == 1                      else MultipleLockGroups
 5. COMP successor outputs over whole tx == 1           else InvalidSuccessorCount
 6. input.type is none                                  else TypeScriptNotAllowed
 7. successor.type is none                              else TypeScriptNotAllowed
 8. successor.lock bytes == input.lock bytes            else LockMismatch
 9. out_cap + max_fee >= in_cap (overflow-safe)         else CapacityExceeded
10. load_cell_data(input, GroupInput)
    == load_cell_data(successor, Output)                 else DataMutated   <- NEW
11. verify_message(witness #0)                          else WitnessFormat / InvalidIdentity / SignatureInvalid
```

Step 10 compares length first, then bytes; a length mismatch is `DataMutated`.

### Error codes

v0.3 codes `1..=16` keep their meaning (code 5 is unused). One code is appended:

| code | name | meaning |
| --- | --- | --- |
| 17 | `DataMutated` | successor `data` differs from the input `data` |

## 7. Transaction invariants

- `inputs[i].previous_output` must be a live COMP cell
- `inputs[i].since` is exactly relative block 1 → each transition waits one committed block
- `outputs[successor].data` byte-identical to `inputs[comp].data`
- `sum(output capacities) >= sum(input capacities) - max_fee`
- no `type` on either side; no additional COMP cells anywhere in the tx

## 8. State transition table

| # | scenario | input | output | witness | result |
| --- | --- | --- | --- | --- | --- |
| 1 | create channel | wallet cell(s) | COMP cell, data = metadata | author sig on wallet input | ok (lock not executed) |
| 2 | anonymous post | 1 COMP cell | 1 COMP cell, same data, cap − fee | JSON, no identity | ok |
| 3 | signed post | 1 COMP cell | same as above | JSON with pubkey+sig | ok |
| 4 | sponsor tops up | 1 COMP cell + wallet cell | 1 COMP cell, same data, cap + X | wallet sig | ok (rule 9 allows increase) |
| 5 | mutate data | 1 COMP cell | 1 COMP cell, data changed | any | **DataMutated** |
| 6 | two successors | 1 COMP cell | 2 COMP cells | any | InvalidSuccessorCount |
| 7 | merge two cells | 2 COMP cells | 1 COMP cell | any | InvalidInputCount |
| 8 | add type script | 1 COMP cell | 1 COMP cell + type | any | TypeScriptNotAllowed |
| 9 | drop capacity too much | 1 COMP cell | 1 COMP cell, cap − (max_fee+1) | any | CapacityExceeded |
| 10 | wrong since | 1 COMP cell | 1 COMP cell | any | InvalidSince |

## 9. Serialization and hashing

- spec hash: `blake2b_256` (CKB default)
- metadata: **comp-meta v2**, a compact binary layout (v0.3 channels used JSON; readers fall back to JSON when byte 0 is not `0x02`):

```
[0]      version 0x02
[1]      flags (bit0 = sponsor present)
[2..4]   name_len (u16 LE)
[4..]    name (UTF-8)
[..]     kind (u8: 0=chat, 1=wall)
[..]     sponsor_len (u8, 0 = none)
[..]     sponsor (UTF-8)
```

  Example: `name="小鲸", kind=chat, sponsor="鱼铺"` → 18 bytes `02010600e5b08fe9b2b80006e9b1bce993ba`
- `channel_hash` derivation is **unchanged** from v0.3 (`blake2b_256("comp-channel-" + slug(name))`), so a v0.4 channel and a v0.3 channel with the same name share the identifier
- capacity: CKB occupies 1 CKB per byte; the 18-byte example costs ~18 CKB of the cell, so `data` can be small

## 10. Security notes

- **Attribution**: because `data` is frozen, a sponsor's name written at creation cannot be replaced later, and a user transacting through that cell can only be advertising that sponsor.
- **No spoof-proofing of names**: anyone can create another cell with the same `channel_hash` and their own `data`; each cell advertises only itself. Clients should surface which cell a message came from.
- **Upgrade**: do **not** upgrade the existing Type ID in place — existing cells would suddenly be judged by v0.4 rules and could fail. Deploy v0.4 as a new code hash; old cells stay on v0.3 semantics.
- **Capacity drain**: `max_fee` bounds per-transition loss; a sponsor must top up before the cell reaches the floor.
- **Replay**: `since = relative 1` and single-successor rule make message replay in another transaction fail at the outpoint level.

## 11. Transaction samples

### 11.1 Create channel (not executed by the lock)

```
cell_deps: []
inputs:    [ wallet cell(s), since = 0 ]
witnesses: [ secp256k1 over the tx (wallet lock) ]
outputs:   [ { lock: COMP(channel_hash, max_fee), capacity: 200 CKB } ]
outputs_data: [ comp-meta v2 bytes (18B for a short name + sponsor) ]
```

### 11.2 Anonymous post

```
cell_deps: [ { outPoint: contract cell, depType: code } ]
inputs:    [ { previous_output: <comp cell>, since: 0x8000000000000001 } ]
outputs:   [ { lock: COMP(channel_hash, max_fee), capacity: in - fee } ]
outputs_data: [ <same metadata bytes> ]
witnesses: [ WitnessArgs{ lock: utf8('{"public_key":null,"signature":null,"extensions":{...}}') } ]
```

Expected scripts: COMP lock only. Fee = `estimateFee(3600)` ≤ `max_fee`.

### 11.3 Negative: mutate data

Same as 11.2 with `outputs_data: [ <metadata bytes with a different sponsor> ]` → `DataMutated` (17).

## 12. Test matrix

| id | case | expected |
| --- | --- | --- |
| T1 | anonymous post, data identical | pass |
| T2 | signed post, valid sig | pass |
| T3 | signed post, signature over wrong digest | `SignatureInvalid` |
| T4 | public_key without signature | `InvalidIdentity` |
| T5 | data one byte different | `DataMutated` |
| T6 | data longer by one byte | `DataMutated` |
| T7 | args length 39 | `ArgsEncoding` |
| T8 | since = absolute height | `InvalidSince` |
| T9 | two COMP outputs | `InvalidSuccessorCount` |
| T10 | two COMP inputs | `InvalidInputCount` |
| T11 | successor lock args changed | `LockMismatch` |
| T12 | capacity drop > max_fee | `CapacityExceeded` |
| T13 | successor carries a type script | `TypeScriptNotAllowed` |
| T14 | capacity increase (sponsor) | pass |
| T15 | missing contract cell_dep | VM failure before script |
| T16 | witness `lock` empty | pass (anonymous) |

Implementation: `ckb-testtool`, mirroring `tests/` of v0.3.
