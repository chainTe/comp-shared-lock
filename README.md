# COMP Shared Lock

A CKB lock script implementing the **COMP Shared Lock v0.3** specification:

> Anyone may use the Cell, but nobody may take the Cell.

A COMP Shared Cell can be consumed by anyone, but its lock, args and type (none)
can never change, only one successor cell may be created per transition, and each
transition may reduce the capacity by at most `max_fee` (shannon). This makes it a
permissionless, community-fundable shared state cell — e.g. an open chat channel or
a gas pool.

It also supports optional message authorship:

- **Anonymous message**: no identity, no signature.
- **Signed message**: `compressed public key + secp256k1 signature` verified on-chain against
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
8. the COMP input uses relative block `since = 1` (`0x8000000000000001`)
9. cell data is unrestricted
10. witness message (optional, JSON in `WitnessArgs.lock` of the group input):
   - `(public_key, signature)` both absent/null → anonymous, valid
   - exactly one present → rejected
   - both present → recoverable secp256k1 signature verified against the public key

## Canonical encoding (COMP v0.2)

```
message_bytes   = [0u8; 65] || utf8(compact_json(extensions))
message_hash    = blake2b_256(message_bytes)
signing_digest  = blake2b_256(tx_hash || message_hash)
signature       = secp256k1 recoverable signature over signing_digest (r || s || v, v ∈ {0,1,2,3,27,28})
```

Identity check: `public_key` is the `0x`-prefixed 33-byte compressed SEC1
secp256k1 public key. It must exactly equal the key recovered from the signature.
No CKB address, network prefix, lock script, or lock args are involved.

## Repository layout

```
contracts/comp-shared-lock/   Rust lock script (ckb-std, no_std)
tests/                        ckb-testtool unit tests (28 cases)
scripts/                      Node.js deploy / post-message / reclaim scripts (CCC)
frontend/                     Vite + TypeScript web UI (CCC)
deployment.json               testnet deployment info
```

## Build & test

```bash
make build        # builds the RISC-V contract binary into build/release/
make test         # builds + runs the 28 unit tests
```

## Legacy testnet deployment (Pudge, COMP v0.1)

The deployment below uses the former CKB-address witness schema. COMP v0.2 has
a new binary/code hash and must be redeployed before the updated scripts or UI
can post signed messages.

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

## COMP Type ID deployment and upgrade

New deployments put the contract binary in a singleton Type ID code cell. The
COMP Lock uses the Type ID script hash as `code_hash` with `hash_type: type`, so
a future binary upgrade can replace the code cell while retaining the same
COMP Lock identity. The code cell and shared Cell #0 are created atomically in
one transaction; output 0 is the code cell and output 1 is the shared Cell.

`deploy.mjs` validates the Type ID derivation (`input[0] + output_index`), keeps
a 5,000 CKB code-cell upgrade reserve, and writes `deployment.json` only after
both outputs are committed and read back as live Cells.

`upgrade.mjs` spends and recreates that singleton code cell with the same Type
ID script, preserving the COMP lock identity while updating the RISC-V binary.
It supports an unsigned preparation step and verifies the committed replacement
before updating `deployment.json`.

## Scripts

```bash
cd scripts && npm install

# Build a transaction from the previous deployment address without exposing a key.
# The result is written under .codex-artifacts/type-id-deployment/.
node deploy.mjs

# Sign and broadcast that exact prepared transaction.
COMP_DEPLOY_KEY=0x<testnet-privkey> node deploy.mjs --send-prepared

# Or build, sign, broadcast, verify, and record a fresh transaction in one run.
COMP_DEPLOY_KEY=0x<testnet-privkey> node deploy.mjs

# Prepare and then broadcast a Type ID in-place contract upgrade.
node upgrade.mjs
COMP_DEPLOY_KEY=0x<testnet-privkey> node upgrade.mjs --send-prepared

# Prepare a Type ID rollback to the preserved pre-upgrade binary.
../.codex-artifacts/since-upgrade/rollback.sh testnet

# post an anonymous / signed message (on-chain e2e)
# no fee-payer key: the network fee is deducted from the shared Cell
node post-message.mjs anonymous
node post-message.mjs signed
```

## Frontend

```bash
cd frontend && npm install && npm run dev
```

The default frontend is **COMP Wall**, a permissionless public canvas built on
the existing COMP Shared Cell message path. It implements the `comp-wall` v1
batch Event protocol from [`docs/comp-wall-design.md`](docs/comp-wall-design.md):

- fixed 1920×1080 layered Canvas with Pen, Eraser, Text, Shape and local Undo;
- anonymous or browser-key signed Batch Posts, with Draft → Wet Paint → On-chain state;
- Wall Explorer, Activity, Graffiti Detail, Paint Supply and wallet-funded Sponsor flows;
- deterministic multi-Cell history ordering, Time Machine and 1×/4×/16×/64× replay;
- IndexedDB event/draft/pending caches and PNG Snapshot checkpoints;
- responsive desktop/mobile controls, keyboard shortcuts and pinch-to-zoom.

The former text-channel UI remains available at `#/channel/<hash>` for COMP
protocol compatibility, while Wall routes use `#/wall/<hash>`.

Frontend verification:

```bash
cd frontend
npm run check       # typecheck + comp-wall protocol tests + production build
```

The UI discovers all COMP channels as Walls and includes a Create Wall page that
derives a deterministic channel hash from the name, previews the Cell's required
capacity, and submits one or more initial channel Cells through a connected CKB wallet.
Channel metadata is stored in Cell data so its name can be rediscovered on-chain.
The compatibility channel route also lets you post anonymous messages,
post signed messages (identity key can be generated in-browser), while both routes can sponsor
the cell with extra capacity. Message fees are deducted directly from the shared
Cell, so posting does not require a fee-payer key. Only sponsoring requires a
funded testnet private key. The transaction-history panel reconstructs the latest
50 Cell transitions from the indexer, including block/time, message and author,
capacity before/after, capacity delta, transaction fee, status and explorer link.

Each message has a **Copy link** action. It copies a direct URL to a dedicated
transaction page that decodes that message by transaction hash, independently
of the channel history window.

Channel discovery and confirmed message details are cached in browser storage.
Rooms render the saved scan immediately, perform one live refresh when opened,
and only poll tracked pending transactions. Idle rooms stop scanning until the
user presses **Refresh** or reopens the room.

### AI Studio and standalone agent skill

The frontend exposes an **AI Studio** at `#/ai`. An agent or user can choose a
target Wall, describe an artwork in Chinese or English, select a style and
placement, then generate a deterministic preview made entirely from valid
`comp-wall` v1 events. The Studio supports variations, per-event inspection,
undo/clear, exact event JSON, and a **Stage on Wall** handoff. Staging only adds
to the local Wall draft; the normal Wall composer remains the final review and
Post surface.

Its primary download is the cross-agent `$comp-wall-artist` Skill. The page
copies one install command that places the same package in both
`~/.agents/skills/comp-wall-artist` for local Codex and
`~/.claude/skills/comp-wall-artist` for local Claude, plus a ready-to-paste
prompt containing the selected Wall URL and creative brief. Every Wall header
links back to this flow through **AI Draw**.

The page also keeps the downloadable standalone `comp-shared-lock` skill. Its
bundled Node.js CLI connects directly to the CKB testnet RPC, so querying
channels, reading messages, checking transactions and posting anonymous
messages do not require an MCP server, a COMP backend, a repository checkout or
browser control by the AI. Message submission is split into draft and explicitly
confirmed send commands. Funded channel and Cell operations remain in the
wallet UI.

Rebuild the downloadable skill after changing its scripts or deployment:

```bash
./scripts/build-ai-skill.sh
```

## Security notes

- All capacity arithmetic uses checked operations (`checked_add`).
- The script never interprets cell data; message parsing rejects duplicate
  identity fields, invalid JSON types/nesting and trailing bytes.
- Signed identities use address-independent compressed public keys, and message
  hashing is incremental to avoid a second witness-sized allocation.
- Witnesses do not affect `tx_hash`, so signatures can be produced after the
  transaction is assembled and still bind the whole transaction.
