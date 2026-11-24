// End-to-end: the compiled SBF program running in LiteSVM, driven only through the SDK
// and contracts written in SolML. Requires target/deploy/solml_escrow.so (cargo-build-sbf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeSync } from "node:fs";
const T = (m) => process.env.SOLML_TRACE && writeSync(2, `trace: ${m}\n`);
T("module loaded");
import { fileURLToPath } from "node:url";
import { Clock, LiteSVM, TransactionMetadata } from "litesvm";
import {
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createInitializePermanentDelegateInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  unpackAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { compile } from "@solml/compiler";
import * as sdk from "../dist/index.js";

const SO = fileURLToPath(new URL("../../../target/deploy/solml_escrow.so", import.meta.url));
const skip = !existsSync(SO) && "build the program first: cargo-build-sbf";
const T0 = 1_800_000_000n;
const DAY = 86_400n;

function world() {
  T("world: new LiteSVM");
  // No transaction history: the tests never look transactions up by signature.
  const svm = new LiteSVM().withTransactionHistory(0n);
  T("world: created");
  const admin = Keypair.generate();
  svm.airdrop(admin.publicKey, 100_000_000_000n);
  // Load as an upgradeable program whose upgrade authority is `admin`, so init_config can check it.
  const elf = readFileSync(SO);
  const pid = sdk.PROGRAM_ID;
  const pdata = sdk.programDataAddress(pid);
  const loader = sdk.BPF_UPGRADEABLE_LOADER;
  T("world: addProgramFromFile");
  svm.addProgramFromFile(pid, SO);
  T("world: added");
  const progData = Buffer.alloc(4 + 32);
  progData.writeUInt32LE(2, 0);
  pdata.toBuffer().copy(progData, 4);
  const pdHeader = Buffer.alloc(4 + 8 + 1 + 32);
  pdHeader.writeUInt32LE(3, 0);
  pdHeader.writeUInt8(1, 12);
  admin.publicKey.toBuffer().copy(pdHeader, 13);
  const pdBytes = Buffer.concat([pdHeader, elf]);
  svm.setAccount(pdata, {
    executable: false,
    owner: loader,
    lamports: svm.minimumBalanceForRentExemption(BigInt(pdBytes.length)),
    data: pdBytes,
    rentEpoch: 0,
  });
  svm.setAccount(pid, {
    executable: true,
    owner: loader,
    lamports: svm.minimumBalanceForRentExemption(36n),
    data: progData,
    rentEpoch: 0,
  });
  T("world: setTime");
  setTime(svm, T0);
  T("world: ready");
  const w = { svm, admin };
  w.send = (ixs, signers) => send(svm, ixs, signers);
  w.fund = (kp) => svm.airdrop(kp.publicKey, 10_000_000_000n);
  return w;
}

function setTime(svm, ts) {
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, ts));
}

function send(svm, ixs, signers) {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.add(...ixs);
  tx.sign(...signers);
  if (process.env.SOLML_TRACE) T("send " + ixs.map((i) => i.programId.toBase58().slice(0, 6) + ":" + i.data.length).join(","));
  const res = svm.sendTransaction(tx);
  if (process.env.SOLML_TRACE) T("sent " + (res instanceof TransactionMetadata ? "ok" : "failed"));
  svm.expireBlockhash();
  if (!(res instanceof TransactionMetadata)) {
    if (process.env.SOLML_TRACE) T("reading failure");
    const logs = res.meta().logs();
    if (process.env.SOLML_TRACE) T("failure logs " + logs.length);
    const err = new Error(`tx failed: ${res.err()}\n${logs.join("\n")}`);
    err.logs = logs;
    throw err;
  }
  for (const ix of ixs) {
    if (!ix.programId.equals(sdk.PROGRAM_ID)) continue;
    const name = IX_NAMES.find((n) => Buffer.from(sdk.discriminator("global", n)).equals(ix.data.subarray(0, 8)));
    const cu = Number(res.computeUnitsConsumed());
    CU.set(name, Math.max(CU.get(name) ?? 0, cu));
  }
  return res.logs();
}

const IX_NAMES = ["init_config", "set_config", "allow_mint", "create_escrow", "deposit", "verify", "vote", "contest",
  "resolve", "crank", "payout", "claim_warranty", "resolve_warranty", "close"];
const CU = new Map();
process.on("exit", () => {
  if (process.env.SOLML_CU) console.error("CU " + JSON.stringify(Object.fromEntries(CU)));
});

function expectFail(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.ok(e.logs?.some((l) => l.includes(code)), `expected ${code}, got:\n${e.message}`);
    return;
  }
  assert.fail(`expected failure ${code}`);
}

function balance(svm, ata) {
  const acc = svm.getAccount(ata);
  if (!acc) return null;
  return unpackAccount(ata, { ...acc, data: Buffer.from(acc.data) }, acc.owner).amount;
}

function escrowState(svm, escrow) {
  const acc = svm.getAccount(escrow);
  return acc ? sdk.decodeEscrow(acc.data) : null;
}

function createMint(w, authority, decimals, program = TOKEN_PROGRAM_ID) {
  const mint = Keypair.generate();
  const space = 82;
  w.send(
    [
      SystemProgram.createAccount({
        fromPubkey: w.admin.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(space))),
        space,
        programId: program,
      }),
      createInitializeMint2Instruction(mint.publicKey, decimals, authority.publicKey, authority.publicKey, program),
    ],
    [w.admin, mint],
  );
  return mint.publicKey;
}

function ataFor(w, mint, owner, program = TOKEN_PROGRAM_ID) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
  if (!w.svm.getAccount(ata)) {
    w.send([createAssociatedTokenAccountInstruction(w.admin.publicKey, ata, owner, mint, program)], [w.admin]);
  }
  return ata;
}

/** Program config + an allowed 6-decimal settlement mint + funded parties. */
function setup() {
  const w = world();
  const p = Object.fromEntries(
    ["arbiter", "treasury", "service", "client", "g0", "g1", "g2", "cranker"].map((k) => [k, Keypair.generate()]),
  );
  for (const kp of Object.values(p)) w.fund(kp);
  w.send(
    [sdk.initConfigIx({ admin: w.admin.publicKey, arbiter: p.arbiter.publicKey, treasury: p.treasury.publicKey, protocolFeeBps: 50 })],
    [w.admin],
  );
  const mint = createMint(w, w.admin, 6);
  w.send([sdk.allowMintIx({ admin: w.admin.publicKey, mint })], [w.admin]);
  const ata = {};
  for (const k of ["service", "client", "treasury", "g0", "g1", "g2"]) ata[k] = ataFor(w, mint, p[k].publicKey);
  for (const k of ["service", "client"]) {
    w.send([createMintToInstruction(mint, ata[k], w.admin.publicKey, 1_000_000_000_000n)], [w.admin]);
  }
  return { w, p, mint, ata };
}

function build(src, sheet) {
  return compile({ contract: { file: "t.solml", text: src }, sheets: sheet ? [{ file: "t.sss", text: sheet }] : [] });
}

function createAndFund(ctx, out, { serviceDeposits = true } = {}) {
  const { w, p, mint, ata } = ctx;
  w.send([sdk.createEscrowIx({ creator: p.service.publicKey, mint, termsBytes: out.termsBytes, termsHash: out.termsHash })], [p.service]);
  const escrow = sdk.escrowPda(out.termsHash);
  let e = escrowState(w.svm, escrow);
  assert.equal(e.state, sdk.EscrowState.Funding);
  w.send(
    [sdk.depositIx({ depositor: p.client.publicKey, escrow, mint, from: ata.client, amount: sdk.depositRequired(e, "client") })],
    [p.client],
  );
  if (serviceDeposits && e.terms.serviceBond > 0n) {
    w.send(
      [sdk.depositIx({ depositor: p.service.publicKey, escrow, mint, from: ata.service, amount: e.terms.serviceBond })],
      [p.service],
    );
  }
  return escrow;
}

function closeAll(ctx, escrow) {
  const { w, p, mint, ata } = ctx;
  const e = escrowState(w.svm, escrow);
  const logs = w.send(
    [
      sdk.closeIx({
        caller: p.cranker.publicKey,
        escrow,
        creator: e.creator,
        mint,
        serviceToken: ata.service,
        clientToken: ata.client,
        treasuryToken: ata.treasury,
        guarantorTokens: e.terms.guarantors.map((g) => ata[["g0", "g1", "g2"].find((k) => p[k].publicKey.toBase58() === new PublicKey(g).toBase58())]),
      }),
    ],
    [p.cranker],
  );
  return sdk.findEvent(logs, "EscrowClosed", sdk.decodeEscrowClosed);
}

const snapshot = (ctx) =>
  Object.fromEntries(Object.entries(ctx.ata).map(([k, a]) => [k, balance(ctx.w.svm, a)]));
const diff = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));

test("token launch: checks pass, guarantors approve, warranty ends, vault splits exactly", { skip }, () => {
  const ctx = setup();
  const { w, p, mint } = ctx;
  // The launched token: supply minted, then both authorities revoked.
  const launched = createMint(w, p.service, 9);
  const lata = ataFor(w, launched, p.service.publicKey);
  w.send([createMintToInstruction(launched, lata, p.service.publicKey, 1_000_000_000_000_000_000n)], [p.service]);

  const src = `
<escrow id="launch-e2e" settle="mint:${mint.toBase58()}" decimals="6" symbol="USDT">
  <meta name="guarantor" content="wallet:${p.g0.publicKey.toBase58()}" />
  <meta name="guarantor" content="wallet:${p.g1.publicKey.toBase58()}" />
  <meta name="guarantor" content="wallet:${p.g2.publicKey.toBase58()}" />
  <service wallet="${p.service.publicKey.toBase58()}" />
  <client wallet="${p.client.publicKey.toBase58()}" />
  <deposit from="client" amount="20000 USDT" />
  <milestone id="mint" weight="40%" deadline="7d">
    <check mint="${launched.toBase58()}" mint-authority="revoked" />
    <check mint="${launched.toBase58()}" freeze-authority="revoked" />
    <check mint="${launched.toBase58()}" mint-supply="1000000000000000000" />
  </milestone>
  <milestone id="airdrop" weight="60%" deadline="21d" release="vote" />
  <warranty period="30d" hold="10%" />
</escrow>`;
  const out = build(src);
  const escrow = createAndFund(ctx, out);
  const before = snapshot(ctx);
  let e = escrowState(w.svm, escrow);
  assert.equal(e.state, sdk.EscrowState.Active);
  assert.equal(e.terms.serviceBond, 4_000_000_000n); // 20% base sheet default, rounded up

  // Checks fail while authorities are still set: bits recorded, status unchanged.
  const checkMints = [launched, launched, launched];
  w.send([sdk.verifyIx({ caller: p.cranker.publicKey, escrow, index: 0, checkMints })], [p.cranker]);
  e = escrowState(w.svm, escrow);
  assert.equal(e.milestones[0].status, sdk.MilestoneStatus.Pending);
  assert.equal(e.milestones[0].checksPassed, 0b100);

  w.send(
    [
      createSetAuthorityInstruction(launched, p.service.publicKey, AuthorityType.MintTokens, null),
      createSetAuthorityInstruction(launched, p.service.publicKey, AuthorityType.FreezeAccount, null),
    ],
    [p.service],
  );
  w.send([sdk.verifyIx({ caller: p.cranker.publicKey, escrow, index: 0, checkMints })], [p.cranker]);
  assert.equal(escrowState(w.svm, escrow).milestones[0].status, sdk.MilestoneStatus.Passed);

  w.send([sdk.payoutIx({ caller: p.cranker.publicKey, escrow, mint, serviceToken: ctx.ata.service, index: 0 })], [p.cranker]);
  e = escrowState(w.svm, escrow);
  assert.equal(e.released, 7_200_000_000n); // 8,000 USDT minus 10% hold
  assert.equal(e.held, 800_000_000n);

  // Guarantor vote: a non-guarantor cannot vote; 2 of 3 approvals meet ⌈2N/3⌉.
  expectFail(() => w.send([sdk.voteIx({ guarantor: p.client.publicKey, escrow, index: 1, approve: true })], [p.client]), "NotAGuarantor");
  w.send([sdk.voteIx({ guarantor: p.g0.publicKey, escrow, index: 1, approve: true })], [p.g0]);
  expectFail(() => w.send([sdk.voteIx({ guarantor: p.g0.publicKey, escrow, index: 1, approve: true })], [p.g0]), "AlreadyVoted");
  w.send([sdk.voteIx({ guarantor: p.g1.publicKey, escrow, index: 1, approve: true })], [p.g1]);
  e = escrowState(w.svm, escrow);
  assert.equal(e.milestones[1].status, sdk.MilestoneStatus.Contestable);

  // The contest window is a condition, not an event: nothing happens until it passes and someone cranks.
  expectFail(() => w.send([sdk.crankIx({ caller: p.cranker.publicKey, escrow, index: 1 })], [p.cranker]), "NothingToDo");
  setTime(w.svm, T0 + 3n * DAY);
  w.send([sdk.crankIx({ caller: p.cranker.publicKey, escrow, index: 1 })], [p.cranker]);
  w.send([sdk.payoutIx({ caller: p.cranker.publicKey, escrow, mint, serviceToken: ctx.ata.service, index: 1 })], [p.cranker]);
  e = escrowState(w.svm, escrow);
  assert.equal(e.state, sdk.EscrowState.Warranty);

  setTime(w.svm, T0 + 34n * DAY);
  w.send([sdk.crankIx({ caller: p.cranker.publicKey, escrow, index: sdk.ESCROW_LEVEL })], [p.cranker]);
  assert.equal(escrowState(w.svm, escrow).state, sdk.EscrowState.Completed);

  const closed = closeAll(ctx, escrow);
  const d = diff(before, snapshot(ctx));
  assert.equal(d.service, 18_000_000_000n + 2_000_000_000n + 4_000_000_000n); // payouts + hold + bond
  assert.equal(d.client, 1_000_000_000n); // client bond back
  assert.equal(d.g0, 100_000_000n); // 1% fee split between the two coherent seats
  assert.equal(d.g1, 100_000_000n);
  assert.equal(d.g2, 0n); // never voted
  assert.equal(d.treasury, 100_000_000n); // 0.5% protocol fee
  assert.equal(closed.toTreasury, 100_000_000n);
  assert.equal(w.svm.getAccount(escrow), null, "escrow account closed");
  assert.equal(w.svm.getAccount(sdk.vaultAddress(mint, escrow)), null, "vault closed");
});

test("hold shorthand: timed transfer releases only after the deadline", { skip }, () => {
  const ctx = setup();
  const { w, p, mint } = ctx;
  const out = build(`<hold id="pay-e2e" settle="mint:${mint.toBase58()}" decimals="6" symbol="TKN"
    from="${p.client.publicKey.toBase58()}" to="${p.service.publicKey.toBase58()}" amount="250000 TKN" duration="7d" />`);
  const escrow = createAndFund(ctx, out);
  const before = snapshot(ctx);
  assert.equal(escrowState(w.svm, escrow).state, sdk.EscrowState.Active, "no service bond needed");

  expectFail(() => w.send([sdk.crankIx({ caller: p.cranker.publicKey, escrow, index: 0 })], [p.cranker]), "NothingToDo");
  setTime(w.svm, T0 + 7n * DAY);
  const tipBefore = w.svm.getBalance(p.cranker.publicKey);
  w.send([sdk.crankIx({ caller: p.cranker.publicKey, escrow, index: 0 })], [p.cranker]);
  assert.equal(w.svm.getBalance(p.cranker.publicKey) - tipBefore, 20_000n - 5_000n, "tip minus fee");
  w.send([sdk.payoutIx({ caller: p.cranker.publicKey, escrow, mint, serviceToken: ctx.ata.service, index: 0 })], [p.cranker]);
  assert.equal(escrowState(w.svm, escrow).state, sdk.EscrowState.Completed);
  closeAll(ctx, escrow);
  const d = diff(before, snapshot(ctx));
  assert.equal(d.service, 250_000_000_000n);
  assert.equal(d.treasury, 1_250_000_000n);
  assert.equal(d.client, 0n);
});

test("funding window expires: everything deposited goes back", { skip }, () => {
  const ctx = setup();
  const { w, p, mint } = ctx;
  const out = build(`<escrow id="refund-e2e" settle="mint:${mint.toBase58()}" decimals="6" symbol="T">
    <meta name="guarantor" content="wallet:${p.g0.publicKey.toBase58()}" />
    <service wallet="${p.service.publicKey.toBase58()}" /><client wallet="${p.client.publicKey.toBase58()}" />
    <deposit from="client" amount="1000" /><milestone id="work" weight="100%" deadline="7d" /></escrow>`);
  const before = snapshot(ctx);
  const escrow = createAndFund(ctx, out, { serviceDeposits: false });
  assert.equal(escrowState(w.svm, escrow).state, sdk.EscrowState.Funding);
  setTime(w.svm, T0 + 8n * DAY);
  expectFail(
    () => w.send([sdk.depositIx({ depositor: p.service.publicKey, escrow, mint, from: ctx.ata.service, amount: 200_000_000n })], [p.service]),
    "FundingClosed",
  );
  w.send([sdk.crankIx({ caller: p.cranker.publicKey, escrow, index: sdk.ESCROW_LEVEL })], [p.cranker]);
  assert.equal(escrowState(w.svm, escrow).state, sdk.EscrowState.Refunded);
  closeAll(ctx, escrow);
  assert.deepEqual(diff(before, snapshot(ctx)), { service: 0n, client: 0n, treasury: 0n, g0: 0n, g1: 0n, g2: 0n });
});

test("missed check deadline is a service fault: unreleased price and bond share go to the client", { skip }, () => {
  const ctx = setup();
  const { w, p, mint } = ctx;
  const launched = createMint(w, p.service, 0);
  const out = build(
    `<escrow id="fault-e2e" settle="mint:${mint.toBase58()}" decimals="6" symbol="T">
      <service wallet="${p.service.publicKey.toBase58()}" /><client wallet="${p.client.publicKey.toBase58()}" />
      <deposit from="client" amount="10000" />
      <milestone id="mint" weight="100%" deadline="7d"><check mint="${launched.toBase58()}" mint-authority="revoked" /></milestone>
    </escrow>`,
    "bond[from=service] { fault-share: 75%; }",
  );
  const escrow = createAndFund(ctx, out);
  const before = snapshot(ctx);
  setTime(w.svm, T0 + 7n * DAY);
  w.send([sdk.crankIx({ caller: p.cranker.publicKey, escrow, index: 0 })], [p.cranker]);
  const e = escrowState(w.svm, escrow);
  assert.equal(e.state, sdk.EscrowState.Faulted);
  closeAll(ctx, escrow);
  const d = diff(before, snapshot(ctx));
  // price 10,000 + client bond 500 + 75% of the 2,000 service bond; no guarantors so no fee
  assert.equal(d.client, 10_000_000_000n + 500_000_000n + 1_500_000_000n);
  assert.equal(d.service, 500_000_000n);
  assert.equal(d.treasury, 50_000_000n);
});

test("client contests an approval and loses: milestone pays, client bond share moves to service", { skip }, () => {
  const ctx = setup();
  const { w, p, mint } = ctx;
  const out = build(`<escrow id="dispute-e2e" settle="mint:${mint.toBase58()}" decimals="6" symbol="T">
    <meta name="guarantor" content="wallet:${p.g0.publicKey.toBase58()}" />
    <service wallet="${p.service.publicKey.toBase58()}" /><client wallet="${p.client.publicKey.toBase58()}" />
    <deposit from="client" amount="1000" /><milestone id="work" weight="100%" deadline="7d" /></escrow>`);
  const escrow = createAndFund(ctx, out);
  const before = snapshot(ctx);
  w.send([sdk.voteIx({ guarantor: p.g0.publicKey, escrow, index: 0, approve: true })], [p.g0]);
  expectFail(() => w.send([sdk.contestIx({ party: p.service.publicKey, escrow, index: 0 })], [p.service]), "CannotContest");
  w.send([sdk.contestIx({ party: p.client.publicKey, escrow, index: 0 })], [p.client]);
  expectFail(() => w.send([sdk.resolveIx({ arbiter: p.client.publicKey, escrow, index: 0, approve: false })], [p.client]), "ConstraintHasOne");
  w.send([sdk.resolveIx({ arbiter: p.arbiter.publicKey, escrow, index: 0, approve: true })], [p.arbiter]);
  const e = escrowState(w.svm, escrow);
  assert.equal(e.clientStrike, true);
  w.send([sdk.payoutIx({ caller: p.cranker.publicKey, escrow, mint, serviceToken: ctx.ata.service, index: 0 })], [p.cranker]);
  closeAll(ctx, escrow);
  const d = diff(before, snapshot(ctx));
  assert.equal(d.service, 1_000_000_000n + 200_000_000n + 25_000_000n); // price + bond + half the 50 client bond
  assert.equal(d.client, 25_000_000n);
  assert.equal(d.g0, 10_000_000n); // seat voted with the final outcome
});

test("mint gate rejects a Token-2022 mint with a permanent delegate", { skip }, () => {
  const w = world();
  const arb = Keypair.generate();
  w.send([sdk.initConfigIx({ admin: w.admin.publicKey, arbiter: arb.publicKey, treasury: arb.publicKey, protocolFeeBps: 0 })], [w.admin]);
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.PermanentDelegate]);
  w.send(
    [
      SystemProgram.createAccount({
        fromPubkey: w.admin.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(space))),
        space,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializePermanentDelegateInstruction(mint.publicKey, w.admin.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMint2Instruction(mint.publicKey, 6, w.admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ],
    [w.admin, mint],
  );
  expectFail(
    () => w.send([sdk.allowMintIx({ admin: w.admin.publicKey, mint: mint.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID })], [w.admin]),
    "PermanentDelegate",
  );
});

test("init_config refuses anyone but the upgrade authority", { skip }, () => {
  const w = world();
  const intruder = Keypair.generate();
  w.fund(intruder);
  expectFail(
    () => w.send([sdk.initConfigIx({ admin: intruder.publicKey, arbiter: intruder.publicKey, treasury: intruder.publicKey, protocolFeeBps: 0 })], [intruder]),
    "ConstraintRaw",
  );
});
