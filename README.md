# SolML

A declarative language for escrow contracts on Solana, and the program that enforces them.

- **SolML** (markup) states parties, money, milestones and on-chain checks.
- **SSS** (style sheets) states defaults, constraints and failure policy through a cascade.
- The compiler turns both into a canonical IR, a SHA-256 terms hash, and compact Borsh terms.
- One Anchor program holds every escrow. The escrow address is derived from the terms hash, so a contract file names exactly one escrow.
- Each party receives a soulbound cNFT receipt that commits to the terms hash.

```html
<hold id="pay-dev-0001" settle="mint:CxHu...q2" decimals="6" symbol="GBAGA"
      from="<client>" to="<service>" amount="250000 GBAGA" duration="7d" />
```

## Layout

| Path | Contents |
| --- | --- |
| `spec/` | [SOLML.md](spec/SOLML.md), [SSS.md](spec/SSS.md), [IR.md](spec/IR.md), [ir.schema.json](spec/ir.schema.json), [PROGRAM.md](spec/PROGRAM.md), [RECEIPTS.md](spec/RECEIPTS.md) |
| `packages/compiler` | `@solml/compiler`: parser, SSS cascade, resolver, IR, terms encoder, `solmlc` CLI. One runtime dependency (`@noble/hashes`); runs in Node and browsers |
| `packages/sdk` | `@solml/sdk`: instruction builders, PDAs, account and event decoders, crank planner, receipt builder and verifier, `solml` CLI |
| `programs/solml_escrow` | Anchor 0.32 program (Rust) |
| `tools/receipt-minter` | Bubblegum V2 minter for soulbound receipts |
| `apps/web` | Playground and spec reader (Vite, 51 KB gzipped). Deployed on Vercel from this folder |
| `examples/` | `token-launch.solml` + `.sss`, `hold.solml`, `broken.solml` (every error class) |
| `keys/` | Program deploy keypair (git-ignored) |

## Build and test

Requirements: Node 22, Rust 1.85+, Solana/Agave 2.3 release (for `cargo-build-sbf` and `solana-test-validator`).

```bash
npm install
npm run build          # compiler, SDK, receipt minter
npm run build:program  # target/deploy/solml_escrow.so (530,528 bytes)
npm test               # compiler + SDK, including end-to-end runs of the .so in LiteSVM
npm run test:program   # Rust: settlement math + TS→Rust byte conformance
```

`Cargo.lock` is resolved for Rust 1.84, the compiler shipped in Solana platform-tools v1.48, and pins `blake3` 1.8.2. Regenerate it with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile` followed by `cargo update -p blake3 --precise 1.8.2`.

## Verification record

| Layer | How | Result |
| --- | --- | --- |
| Compiler | 14 unit tests: units, cascade order, constraints, hard bounds, diagnostics with line/column, hash stability, max-size terms | Pass |
| Rust | 10 math tests (every outcome sums to the vault), 3 conformance tests on bytes produced by the TS compiler | Pass |
| Program (SBF) | 7 end-to-end tests in LiteSVM 1.6 (also on GitHub Actions): launch with checks + vote + warranty, `<hold>`, funding refund, service fault, lost contest, mint gate rejection, init authority | Pass |
| Receipts | 5 tests: build, verify, tamper detection, close-event match, largest contract fits one 1,232-byte transaction | Pass |
| CLI | Full `<hold>` flow on `solana-test-validator`: deploy, `init-config`, `allow-mint`, `create`, `deposit`, `crank` → payout → close | Pass |
| IR schema | Example IRs validate under Ajv (draft 2020-12); a tampered IR is rejected | Pass |
| Receipt minter | Type-checked against mpl-bubblegum 5.1 / mpl-core; not run against a cluster | Not run |
| Devnet / mainnet | No deployment yet | Not run |
| Security audit | None | Not done |
| Web playground | Browser address derivation matched web3.js on 200 random terms hashes; desktop and phone screenshots reviewed | Pass |

## Transacting with a project token (devnet)

```bash
solana program deploy target/deploy/solml_escrow.so --program-id keys/solml_escrow-keypair.json -u devnet
solml init-config --arbiter <key> --treasury <key> --fee-bps 50 --keypair <upgrade-authority.json> --url https://api.devnet.solana.com
solml allow-mint <your-mint> --keypair <admin.json> --url https://api.devnet.solana.com
solml build  examples/hold.solml                      # prints terms hash, escrow and vault addresses
solml create examples/hold.solml --keypair <payer.json> --url <rpc>
solml deposit <escrow> --keypair <client.json> --url <rpc>
solml crank   <escrow> --keypair <anyone.json> --url <rpc>   # after the deadline: release, payout, close
```

Program data rent for the 530,528-byte binary is (530,528 + 45 + 128) × 6,960 lamports ≈ 3.69 SOL; the deploy buffer needs the same amount temporarily.

## v1 scope

| In v1 | Specified, not in v1 |
| --- | --- |
| Wallet guarantor seats, ⌈2N/3⌉ votes, contest window | `dex:` and `sharks` seats, shark panel with commit–reveal |
| Arbiter key resolves disputes | Stake-weighted arbitration, appeal fees |
| Checks: mint authority, freeze authority, supply | Pool, LP lock, distributor, vesting checks |
| SPL Token and Token-2022 (transfer fee, pausable flagged) | Token-2022 transfer hooks |
| Receipts minted off-program by the platform key | Program-owned receipt tree |
