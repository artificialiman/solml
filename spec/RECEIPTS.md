# Receipt Protocol 1

Every escrow issues one soulbound compressed NFT per role. A receipt is proof of the terms a wallet signed up to and, after close, of the outcome.

## 1. Who receives one

| Order | Role | Owner |
| --- | --- | --- |
| 1 | service | `parties.service` |
| 2 | client | `parties.client` |
| 3+ | guarantor, seat n | `guarantors[n]` |

## 2. Lifecycle

| Phase | When | Action |
| --- | --- | --- |
| bound | Escrow is Active | `mintV2` into the receipts tree and collection, then `setNonTransferableV2` |
| closed | `EscrowClosed` event seen | `updateMetadataV2` to closed-phase metadata |

Tool: `tools/receipt-minter` (`setup`, `files`, `mint`, `close`). It needs a DAS-capable RPC and a collection whose PermanentFreezeDelegate authority is the minter.

## 3. Metadata

Metaplex JSON with a `properties.solml` block:

| Field | Meaning |
| --- | --- |
| `version` | 1 |
| `escrow` | Escrow address, derived from the terms hash |
| `termsHash` | Hex SHA-256 of the canonical IR |
| `role`, `seat`, `owner` | Which recipient this is |
| `irUri` | Where the IR lives (permanent storage) |
| `phase` | `bound` or `closed` |
| `outcome` | Closed phase only: state, service fault, client strike, every amount paid |

`name` is `<id> <role>`, ≤ 32 bytes. `symbol` is `SOLML`.

## 4. Verification

Given a receipt and the IR at its `irUri`:

1. SHA-256 of the canonical IR equals `termsHash`.
2. `PDA(["escrow", termsHash])` equals `escrow`.
3. The IR names `owner` for this `role`/`seat`, and the receipt is held by `owner`.
4. Optional: compact terms compiled from the IR equal the bytes in the `EscrowCreated` event.
5. Optional, closed phase: `outcome` equals the `EscrowClosed` event.

`solml verify-receipt <metadata.json> <ir.json>` runs checks 1–3.

## 5. Tree sizing (Bubblegum V2, one-time rent)

| Depth / canopy | Receipts | Rent | Escrows at 5 receipts each |
| --- | --- | --- | --- |
| 14 / 8 | 16,384 | ~0.34 SOL | 3,276 |
| 20 / 13 | 1,048,576 | ~8.50 SOL | 209,715 |
