# Escrow Program v1

One Anchor 0.32 program holds every escrow. Program ID: `3bNY3MoiTTYZMCg3imcHF1UKGuNJ8M2186uSSvMd8SKV` (keypair in `keys/`, not in git).

## 1. Accounts

| Account | Seeds | Size (bytes) | Lifetime |
| --- | --- | --- | --- |
| Config | `["config"]` | 107 | Permanent. Admin, arbiter, treasury wallet, protocol fee |
| MintAllow | `["mint", mint]` | 75 | Permanent. One per mint that passed the mint gate |
| Escrow | `["escrow", terms_hash]` | 8 + 128 + 4 + 24·milestones + terms | Create → close |
| Vault | Associated token account of (mint, escrow) | 165+ | Create → close |

Escrow rent is `(128 + size) × 6,960` lamports and returns to the creator on close, together with unused crank tips.

## 2. Instructions

| Instruction | Signer | Arguments | Effect |
| --- | --- | --- | --- |
| `init_config` | Program upgrade authority | arbiter, treasury, protocol_fee_bps | Creates Config once |
| `set_config` | Admin | admin, arbiter, treasury, protocol_fee_bps | Updates Config |
| `allow_mint` | Admin | — | Runs the mint gate; creates MintAllow |
| `create_escrow` | Anyone | EscrowTerms | Validates terms, creates Escrow + Vault, funds the tip pool |
| `deposit` | Client or service | amount | Moves tokens in; credit = vault balance change |
| `verify` | Anyone | milestone | Reads check mints (remaining accounts, in check order) |
| `vote` | Guarantor seat | milestone, approve | One vote per seat per milestone |
| `contest` | Losing party | milestone | Inside the contest window → dispute |
| `resolve` | Arbiter | milestone, approve | Decides a disputed milestone |
| `crank` | Anyone | milestone or 255 | Applies the stored policy after a deadline; pays the tip |
| `payout` | Anyone | milestone | Pays a passed milestone to the service, keeps the warranty hold |
| `claim_warranty` | Client | — | Inside the warranty period → dispute |
| `resolve_warranty` | Arbiter | uphold | Decides a warranty dispute |
| `close` | Anyone | — | Splits the vault, closes vault and escrow. Remaining accounts: one token account per guarantor seat, in seat order |

Account order for each instruction is the field order of its `#[derive(Accounts)]` struct in `src/lib.rs`; `packages/sdk/src/program.ts` builds them in the same order.

### Compute (measured, LiteSVM 1.6, peak per instruction)

| Instruction | CU |
| --- | --- |
| create_escrow | 56,943 |
| close | 32,842 |
| payout | 18,924 |
| deposit | 18,905 |
| allow_mint | 14,621 |
| init_config | 9,905 |
| verify | 8,621 |
| resolve | 7,653 |
| vote | 7,586 |
| crank | 7,306 |
| contest | 5,546 |

All are under the 200,000 CU default; no compute-budget instruction is needed.

## 3. States

Escrow: `Funding → Active → Warranty → Completed`, with `Refunded`, `Faulted`, `WarrantyDispute` branches.
Milestone: `Pending → (Voting → Contestable → | Disputed →) Passed → Paid`, or `Failed`.

| From | Event | To |
| --- | --- | --- |
| Funding | Both sides credited | Active |
| Funding | `crank(255)` at/after funding deadline | Refunded |
| Pending, `deadline` | `crank` at/after deadline | Passed |
| Pending, `checks` | `verify`, all checks true | Passed |
| Pending, `checks+vote` | `verify`, all checks true | Voting |
| Pending, `vote` | First vote, or `crank` at deadline | Voting |
| Pending, `checks*` | `crank` at deadline, policy `service-fault` | Failed → escrow Faulted |
| Pending, `checks*` | `crank` at deadline, policy `release` | Passed |
| Voting | ⌈2N/3⌉ same-way votes | Contestable |
| Voting | `crank` after vote window, no result | Disputed |
| Contestable | Losing party `contest` in window | Disputed |
| Contestable | `crank` after contest window | Passed (approve) or Failed (reject) |
| Disputed | `resolve` | Passed or Failed |
| Passed | `payout` | Paid; last one → Warranty or Completed |
| Warranty | `claim_warranty` in period | WarrantyDispute |
| Warranty | `crank(255)` after period | Completed |
| WarrantyDispute | `resolve_warranty(uphold)` | Faulted, else Completed + client strike |

A client who contests an approval and loses, or loses a warranty claim, gets a **client strike**.

## 4. Settlement on close

Symbols: P price, B_s / B_c bonds, F_p protocol fee, F_g guarantor fee, R released to service, k_s / k_c fault shares in bps, v paid guarantor seats. ⌊x·k⌋ means ⌊x·k / 10⁴⌋.

```
client deposit  D_c = P + F_p + F_g + B_c        F_p = ⌊P·fee_bps/10⁴⌋   F_g = ⌊P·g_bps/10⁴⌋
milestone i     R_i = ⌊P·w_i/10⁴⌋ (last takes P − Σ others);  paid = R_i − ⌊R_i·hold/10⁴⌋
unreleased      U = P − R
```

| Outcome | Service | Client | Each paid seat | Treasury |
| --- | --- | --- | --- | --- |
| Completed | U + B_s | B_c | ⌊F_g / v⌋ | F_p + rest |
| Faulted (service) | B_s − ⌊B_s·k_s⌋ | U + B_c + ⌊B_s·k_s⌋ | ⌊F_g / v⌋ | F_p + rest |
| Refunded | its credit | its credit | 0 | 0 |
| Client strike (any non-refund) | + ⌊B_c·k_c⌋ | − ⌊B_c·k_c⌋ | | |

A seat is paid when every vote it cast matched the final outcome and it cast at least one. With no paid seat, F_g goes to the treasury. Any amount a depositor sent above the requirement returns to that depositor. The treasury takes whatever is left, so the vault ends at zero.

## 5. Mint gate

| Mint property | Result |
| --- | --- |
| SPL Token mint | Allowed |
| Token-2022 permanent delegate | Rejected |
| Token-2022 non-transferable | Rejected |
| Token-2022 transfer hook | Rejected in v1 |
| Token-2022 default state frozen | Rejected |
| Token-2022 transfer fee | Allowed; credit is measured, vault is left open on close (withheld fees block closing) |
| Token-2022 pausable | Allowed; flag recorded |
| Freeze authority set | Allowed; flag recorded |

## 6. Events

`EscrowCreated` (full terms), `Deposited`, `Activated`, `MilestoneChanged`, `Voted`, `MilestonePaid`, `StateChanged`, `EscrowClosed` (terms hash, outcome, every amount paid). Events are Anchor `Program data:` log lines and stay in ledger history after the accounts close.

## 7. v1 trust assumptions

- The arbiter key in Config decides disputes. The shark panel replaces it in a later version.
- An unresolved dispute holds the escrow until the arbiter acts.
- Receipts are minted by the platform minter key after reading `EscrowClosed`, not by the program.
