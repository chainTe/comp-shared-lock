# COMP Shared Lock

A CKB lock script implementing the **COMP Shared Lock v0.1** specification:

> Anyone may use the Cell, but nobody may take the Cell.

A COMP Shared Cell can be consumed by anyone, but its lock, args and type (none)
can never change, only one successor cell may be created per transition, and each
transition may reduce the capacity by at most `max_fee` (shannon). This makes it a
permissionless, community-fundable shared state cell — e.g. an open chat channel or
a gas pool.

It also supports optional message authorship:

- **Anonymous message**: no identity, no signature.
- **Signed message**: `address + secp256k1 signature` verified on-chain against
  `signing_digest = blake2b(tx_hash || message_hash)`.

## Lock Args

```
Args { hash: Byte32, max_fee: u64 (LE) }   // 40 bytes total
```

## Validation rules (on-chain)

1. args length == 40
2. only one COMP lock group per transaction (matched by code_hash + hash_type)
3. exactly 1 input in the group (no merge)
4. exactly 1 successor COMP output (no fork)
5. input and successor must not carry a type script
6. successor lock must be byte-identical to input lock (`hash` and `max_fee` immutable)
7. `output_capacity + max_fee >= input_capacity` (overflow-safe; sponsoring allowed)
8. cell data is unrestricted
9. witness message (optional, JSON in `WitnessArgs.lock` of the group input):
   - `(address, signature)` both absent/null → anonymous, valid
   - exactly one present → rejected
   - both present → secp256k1 signature verified

## Canonical encoding (COMP v0.1)

```
message_bytes   = utf8(address) || [0u8; 65] || utf8(compact_json(extensions))
message_hash    = blake2b_256(message_bytes)
signing_digest  = blake2b_256(tx_hash || message_hash)
signature       = secp256k1 recoverable signature over signing_digest (r || s || v, v ∈ {0,1,2,3,27,28})
```

Identity check: the address (short bech32, CCC compact full bech32m
`0x00 || code_hash || hash_type || args`, or molecule full bech32m) is decoded to
its lock args, which must equal `blake2b_256(compressed_pubkey)[..20]` of the key
recovered from the signature.

## Repository layout

```
contracts/comp-shared-lock/   Rust lock script (ckb-std, no_std)
tests/                        ckb-testtool unit tests (19 cases)
scripts/                      Node.js deploy / post-message / reclaim scripts (CCC)
frontend/                     Vite + TypeScript web UI (CCC)
deployment.json               testnet deployment info
```

## Build & test

```bash
make build        # builds the RISC-V contract binary into build/release/
make test         # builds + runs the 19 unit tests
```

## Testnet deployment (Pudge)

| Item | Value |
| --- | --- |
| code_hash (data2) | `0x43fd8315fd9d20de67b2d26ea713b9fff034877d22fec2c5f51ad8a065ac12d9` |
| contract out point | `0xcd56cc438ae1f6697de904cb8b12411beda44bb8a7f111ebc3520c9b90ebab95:0` |
| shared cell #0 | created in `0xa4f5be018b19e081916a75b94a0273fa73be311feea69906c3ecde9693c77f57:0` |
| channel hash | `0x3bf471b16283375362945f60972e6dd4a998db34b53623457dcaa800b6a42726` |
| max_fee | 1,000,000 shannon (0.01 CKB) |

Verified on-chain transitions:

- anonymous message: `0xd89b30f1e9808e201239168b7cbfe2d94f8f78bc076f78ab862c59dbdb06f914`
- signed message: `0x522fc9ba0abd50aed75fc4fa21e10bf7ba52eaeb36983016371f5e3a1b451fd9`

Explorer: `https://pudge.explorer.nervos.org/transaction/<tx_hash>`

## Scripts

```bash
cd scripts && npm install

# deploy the contract and create shared cell #0
COMP_DEPLOY_KEY=0x<testnet-privkey> node deploy.mjs

# post an anonymous / signed message (on-chain e2e)
COMP_DEPLOY_KEY=0x<testnet-privkey> node post-message.mjs anonymous
COMP_DEPLOY_KEY=0x<testnet-privkey> node post-message.mjs signed
```

## Frontend

```bash
cd frontend && npm install && npm run dev
```

The UI shows the current shared cell and lets you post anonymous messages,
post signed messages (identity key can be generated in-browser) and sponsor
the cell with extra capacity. Testnet only — paste any funded testnet private
key as the fee payer.

## Security notes

- All capacity arithmetic uses checked operations (`checked_add`).
- The script never interprets cell data; message parsing is a strict
  minimal JSON scanner with string-aware bracket matching.
- Witnesses do not affect `tx_hash`, so signatures can be produced after the
  transaction is assembled and still bind the whole transaction.
