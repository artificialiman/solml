# SolML

[![ci](https://github.com/artificialiman/solml/actions/workflows/ci.yml/badge.svg)](https://github.com/artificialiman/solml/actions/workflows/ci.yml)

SolML is a markup language for escrow contracts on Solana. A contract file compiles to fixed terms; one Anchor program holds the money and enforces those terms.

- **Playground and docs:** <https://solml.vercel.app>
- **Program ID:** `3bNY3MoiTTYZMCg3imcHF1UKGuNJ8M2186uSSvMd8SKV` (not yet deployed to devnet or mainnet)

## The contract

A timed transfer: the client's 250,000 GBAGA is held for 7 days, then released to the service.

```html
<hold id="pay-dev-0001" settle="mint:CxHuawS9A6mYLy4eVWPZZEdZ85pqwY5ZHtfSgDyqMPq2" decimals="6" symbol="GBAGA"
      from="31CCHqaMqkHnU22qTJdkerwb8FgZFcm3kH1RJPrDbhrz"
      to="CptS4ujvxsFX4pqZB6XekRSqsDsyi6f1RgSEysLT9c1G"
      amount="250000 GBAGA" duration="7d" cluster="devnet" />
```

A token launch (abridged from `examples/token-launch.solml`): 40% of the price pays out when three on-chain checks pass, 60% when two of three guarantors approve the airdrop, and 10% of every payout is held for a 30-day warranty.

```html
<escrow id="launch-0042" settle="USDC" cluster="devnet">
  <meta name="guarantor" content="wallet:HNsj5CmfrpJUnagwyPYEXA3AFrHc3pumiBVWExJWmCSc" />
  <meta name="guarantor" content="wallet:Dy29dmYPrLYnGkctQPt39x1aGicdHg4mN9TMK1bgejQ5" />
  <meta name="guarantor" content="wallet:5XXSejMtDvVydV6E4da8Ba4Sp7Eww8tTQsLvCeWAtnVi" />
  <service wallet="CptS4ujvxsFX4pqZB6XekRSqsDsyi6f1RgSEysLT9c1G" />
  <client wallet="31CCHqaMqkHnU22qTJdkerwb8FgZFcm3kH1RJPrDbhrz" />
  <deposit from="client" amount="20000 USDC" />
  <bond from="service" percent="20%" />
  <milestone id="mint" weight="40%" deadline="7d">
    <check mint="CxHuawS9A6mYLy4eVWPZZEdZ85pqwY5ZHtfSgDyqMPq2" mint-authority="revoked" />
    <check mint="CxHuawS9A6mYLy4eVWPZZEdZ85pqwY5ZHtfSgDyqMPq2" freeze-authority="revoked" />
    <check mint="CxHuawS9A6mYLy4eVWPZZEdZ85pqwY5ZHtfSgDyqMPq2" mint-supply="1000000000000000" />
  </milestone>
  <milestone id="airdrop" weight="60%" deadline="21d" release="vote" />
  <warranty period="30d" hold="10%" />
</escrow>
```

A style sheet sets defaults, limits and failure policy through a cascade. It never moves money.

```css
vote { window: 48h; }
bond[from=service] { fault-share: 75%; }
milestone[id=airdrop] { on-deadline-missed: release; }
```

## What compiling produces

| Output | What it is | `examples/hold.solml` | `examples/token-launch.solml` + `.sss` |
| --- | --- | --- | --- |
| IR | The resolved contract as canonical JSON: keys, integers, no prose ambiguity | `pay-dev-0001.ir.json` | `launch-0042.ir.json` |
| Terms hash | SHA-256 of the canonical IR | `1e72f1b6…902337` | `10984c46…d2d619` |
| Escrow address | `PDA(["escrow", terms_hash])`; any change to the terms moves it | `74WGSodF…F225FNqH` | `Atb83wXi…69kGnuN2ypUv` |
| Compact terms | Borsh bytes passed to `create_escrow` | 206 bytes | 437 bytes |

Formatting, comments and attribute order never change the hash.

## Constants

| Item | Value |
| --- | --- |
| Settlement mints | wSOL, USDC, and any SPL Token or Token-2022 mint that passes the mint gate |
| Milestones per escrow | 1–8; weights sum to exactly 100% |
| Guarantor seats | 0–5; a vote passes at ⌈2N/3⌉ |
| On-chain checks per escrow | 0–6: mint authority revoked, freeze authority revoked, exact supply |
| Compact terms limit | 760 bytes; the largest legal contract fits one 1,232-byte transaction |
| Protocol fee | ≤ 200 bps (program config) |
| Guarantor fee | ≤ 500 bps; base sheet 100 bps |
| Crank tip | 5,000–1,000,000 lamports; base sheet 20,000 |
| Windows (funding, vote, contest) | ≥ 1 hour |
| Program binary | 530,528 bytes |

### Account rent

Rent is (128 + bytes) × 6,960 lamports and returns to the payer when the account closes.

| Account | Bytes | Rent (lamports) | Closed when |
| --- | --- | --- | --- |
| Escrow, `hold.solml` | 370 | 3,466,080 | Escrow closes |
| Escrow, `token-launch.solml` | 625 | 5,240,880 | Escrow closes |
| Vault (token account) | 165 | 2,039,280 | Escrow closes (left open for transfer-fee mints) |
| Config | 107 | 1,635,600 | Never |
| MintAllow, per mint | 75 | 1,412,880 | Never |
| Program data | 530,701 | ≈ 3.69 SOL | Program closed |

The escrow also holds crank tips: crank tip × (3 × milestones + 2). That is 100,000 lamports for `hold.solml` and 160,000 for `token-launch.solml`. Unused tips return to the creator on close.

### Compute (peak per instruction, LiteSVM 1.6)

| create_escrow | close | payout | deposit | allow_mint | init_config | verify | resolve | vote | crank | contest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 56,943 | 32,842 | 18,924 | 18,905 | 14,621 | 9,905 | 8,621 | 7,653 | 7,586 | 7,306 | 5,546 |

All are under the 200,000 CU default, so no compute-budget instruction is needed.

## Time

A deadline on Solana is a condition, not an event: the program can refuse an action before a time, but it cannot start one. Every timed step (release, expiry, vote close, warranty end) is a permissionless `crank` that anyone can send after the deadline. Payouts go only to the keys stored in the terms, and the caller earns the crank tip.

## Layout

| Path | Contents |
| --- | --- |
| `spec/` | [SOLML.md](spec/SOLML.md), [SSS.md](spec/SSS.md), [IR.md](spec/IR.md), [ir.schema.json](spec/ir.schema.json), [PROGRAM.md](spec/PROGRAM.md), [RECEIPTS.md](spec/RECEIPTS.md) |
| `packages/compiler` | `@solml/compiler`: parser, SSS cascade, resolver, IR, terms encoder, `solmlc` CLI. One runtime dependency (`@noble/hashes`); runs in Node and browsers |
| `packages/sdk` | `@solml/sdk`: instruction builders, PDAs, account and event decoders, crank planner, receipt builder and verifier, `solml` CLI |
| `programs/solml_escrow` | Anchor 0.32 program (Rust) |
| `tools/receipt-minter` | Bubblegum V2 minter for soulbound cNFT receipts |
| `apps/web` | Playground and spec reader (Vite, 51 KB gzipped), deployed to Vercel on every push to `main` |
| `examples/` | `token-launch.solml` + `.sss`, `hold.solml`, `broken.solml` (every error class) |

## Build and test

Requirements: Node 22, Rust 1.85+, Agave 2.3 (for `cargo-build-sbf` and `solana-test-validator`).

```bash
npm install
npm run build          # compiler, SDK, receipt minter, web
npm run build:program  # target/deploy/solml_escrow.so
npm test               # compiler + SDK, including end-to-end runs of the .so in LiteSVM
npm run test:program   # Rust: settlement math + TS→Rust byte conformance
```

`Cargo.lock` is resolved for Rust 1.84, the compiler in Solana platform-tools v1.48, and pins `blake3` 1.8.2. To regenerate it: `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`, then `cargo update -p blake3 --precise 1.8.2`.

## Deploy and transact (devnet)

The program keypair is not in the repository. Keep it outside git and pass its path to `--program-id`.

```bash
solana program deploy target/deploy/solml_escrow.so --program-id <solml_escrow-keypair.json> -u devnet
solml init-config --arbiter <key> --treasury <key> --fee-bps 50 --keypair <upgrade-authority.json> --url https://api.devnet.solana.com
solml allow-mint <your-mint> --keypair <admin.json> --url https://api.devnet.solana.com
solml build   examples/hold.solml                               # terms hash, escrow and vault addresses
solml create  examples/hold.solml --keypair <payer.json> --url <rpc>
solml deposit <escrow> --keypair <client.json> --url <rpc>
solml crank   <escrow> --keypair <anyone.json> --url <rpc>      # after the deadline: release, payout, close
```

## Releases

Publishing a GitHub release, or pushing a `v*` tag, builds the program on Actions and attaches `solml_escrow.so` with its SHA-256 checksum.

## Verification record

| Layer | How | Result |
| --- | --- | --- |
| Compiler | 14 unit tests: units, cascade order, constraints, hard bounds, diagnostics with line and column, hash stability, maximum-size terms | Pass |
| Rust | 10 settlement tests (every outcome sums to the vault), 3 conformance tests on bytes produced by the TypeScript compiler | Pass |
| Program (SBF) | 7 end-to-end tests in LiteSVM 1.6, also on GitHub Actions: launch with checks, vote and warranty; `<hold>`; funding refund; service fault; lost contest; mint gate rejection; init authority | Pass |
| Receipts | 5 tests: build, verify, tamper detection, close-event match, largest contract fits one transaction | Pass |
| CLI | Full `<hold>` flow on `solana-test-validator`: deploy, `init-config`, `allow-mint`, `create`, `deposit`, `crank` → payout → close | Pass |
| IR schema | Example IRs validate under Ajv (draft 2020-12); a tampered IR is rejected | Pass |
| Web playground | Browser address derivation matched web3.js on 200 random terms hashes; live on Vercel | Pass |
| Receipt minter | Type-checked against mpl-bubblegum 5.1 and mpl-core; not run against a cluster | Not run |
| Devnet and mainnet | No deployment | Not run |
| Security audit | None | Not done |

## v1 scope

| In v1 | Specified, not in v1 |
| --- | --- |
| Wallet guarantor seats, ⌈2N/3⌉ votes, contest window | `dex:` and `sharks` seats, shark panel with commit–reveal |
| Arbiter key resolves disputes | Stake-weighted arbitration, appeal fees |
| Checks: mint authority, freeze authority, supply | Pool, LP lock, distributor and vesting checks |
| SPL Token and Token-2022 (transfer fee and pausable flagged) | Token-2022 transfer hooks |
| Receipts minted off-program by the platform key | Program-owned receipt tree |

## License

Apache-2.0
