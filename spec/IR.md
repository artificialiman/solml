# Escrow IR 1, Terms Hash, Compact Terms

## 1. IR

The IR is the resolved contract: every role is a key, every number an integer. JSON Schema: [ir.schema.json](ir.schema.json).

| Field | Type | Meaning |
| --- | --- | --- |
| `solml` | `1` | IR version |
| `id` | slug | Contract id |
| `cluster` | `mainnet` \| `devnet` | |
| `settle` | `{ mint, decimals, symbol }` | Settlement mint |
| `parties` | `{ service, client }` | Keys |
| `guarantors` | key[] (0–5) | Seat order = array order |
| `amounts` | `{ price, serviceBond, clientBond, crankTip }` | u64 as decimal strings |
| `rates` | `{ guarantorFee, serviceFaultShare, clientFaultShare, warrantyHold }` | Basis points |
| `windows` | `{ funding, vote, contest, warranty }` | Seconds |
| `milestones` | `{ id, weight, deadline, release, onMissed, checks[] }[]` | 1–8 |
| `receipt` | `{ format: "cnft", soulbound: true }` | |
| `info` | `{ title, deliverables[] }` | Off-chain text, still hashed |

u64 values are strings because JSON numbers lose precision above 2^53.

## 2. Canonical JSON and terms hash

```
canonical(v):
  object  → "{" + keys sorted by code point, each "\"k\":" + canonical(value), joined by "," + "}"
  array   → "[" + items joined by "," + "]"
  string  → JSON string escape
  integer → decimal digits (floats and undefined are errors)
  boolean → true | false

terms_hash = SHA-256( UTF-8( canonical(IR) ) )
```

Formatting, comments and attribute order in the `.solml` file do not change the hash. Any change to a party, amount, window, milestone, check, title or deliverable does.

## 3. Escrow address

```
escrow = PDA( ["escrow", terms_hash], program_id )
vault  = associated token account( mint = settle.mint, owner = escrow, token program of the mint )
```

A contract file therefore names exactly one escrow account per program deployment.

## 4. Compact terms (Borsh)

`create_escrow` receives this layout. Little-endian integers; `vec<T>` = u32 length + items.

| # | Field | Type | Bytes |
| --- | --- | --- | --- |
| 1 | version | u8 | 1 |
| 2 | terms_hash | [u8; 32] | 32 |
| 3 | settle_mint | pubkey | 32 |
| 4 | decimals | u8 | 1 |
| 5 | service | pubkey | 32 |
| 6 | client | pubkey | 32 |
| 7 | guarantors | vec<pubkey> | 4 + 32n |
| 8 | price | u64 | 8 |
| 9 | service_bond | u64 | 8 |
| 10 | client_bond | u64 | 8 |
| 11 | guarantor_fee_bps | u16 | 2 |
| 12 | service_fault_bps | u16 | 2 |
| 13 | client_fault_bps | u16 | 2 |
| 14 | warranty_hold_bps | u16 | 2 |
| 15 | funding_window | u32 | 4 |
| 16 | vote_window | u32 | 4 |
| 17 | contest_window | u32 | 4 |
| 18 | warranty_period | u32 | 4 |
| 19 | crank_tip | u64 | 8 |
| 20 | milestones | vec<Milestone> | 4 + Σ |

Milestone: `weight_bps u16, deadline u32, release u8, on_missed u8, checks vec<Check>` (12 + 41 per check).
Check: `kind u8, mint pubkey, value u64` (41).

| Code table | Values |
| --- | --- |
| release | 0 deadline, 1 checks, 2 vote, 3 checks+vote |
| on_missed | 0 service-fault, 1 release |
| check kind | 0 mint-authority-revoked, 1 freeze-authority-revoked, 2 mint-supply |

### Size limits

| Item | Value |
| --- | --- |
| Compiler limit on compact terms | 760 bytes |
| Largest legal contract (5 seats, 8 milestones, 6 checks) | Fits one legacy 1,232-byte transaction (tested) |
| `launch-0042` example | 437 bytes |
| `<hold>` example | 206 bytes |

### Conformance

`programs/solml_escrow/tests/conformance.rs` decodes bytes produced by the TypeScript compiler, re-encodes them byte for byte, recomputes the terms hash from the canonical IR, and checks the account size formula.
