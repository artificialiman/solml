import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { compile, encodeTerms, termsFromIR } from "@solml/compiler";
import * as sdk from "../dist/index.js";

const ex = (f) => readFileSync(new URL(`../../../examples/${f}`, import.meta.url), "utf8");
const out = compile({
  contract: { file: "token-launch.solml", text: ex("token-launch.solml") },
  sheets: [{ file: "token-launch.sss", text: ex("token-launch.sss") }],
});
const irText = JSON.stringify(out.ir, null, 2);
const irUri = "ar://example-ir";

test("one receipt per role, names fit the 32-byte cNFT limit", () => {
  const r = sdk.receiptRecipients(out.ir);
  assert.deepEqual(r.map((x) => `${x.role}${x.seat ?? ""}`), ["service", "client", "guarantor0", "guarantor1", "guarantor2"]);
  for (const x of r) assert.ok(Buffer.byteLength(sdk.receiptName(out.ir, x)) <= 32);
});

test("a receipt verifies against its IR and the creation-event terms", () => {
  const recipient = sdk.receiptRecipients(out.ir)[1];
  const metadata = sdk.buildReceiptMetadata({ ir: out.ir, recipient, irUri });
  assert.equal(metadata.properties.solml.escrow, sdk.escrowPda(out.termsHash).toBase58());
  const res = sdk.verifyReceipt({ metadata, irText, createdTermsBytes: out.termsBytes, holder: recipient.owner });
  assert.deepEqual(res, { ok: true, failures: [] });
});

test("tampering is caught: edited IR, wrong holder, swapped role", () => {
  const recipient = sdk.receiptRecipients(out.ir)[0];
  const metadata = sdk.buildReceiptMetadata({ ir: out.ir, recipient, irUri });
  const edited = JSON.stringify({ ...out.ir, amounts: { ...out.ir.amounts, price: "1" } });
  assert.equal(sdk.verifyReceipt({ metadata, irText: edited }).ok, false);
  assert.equal(sdk.verifyReceipt({ metadata, irText, holder: Keypair.generate().publicKey.toBase58() }).ok, false);
  const swapped = structuredClone(metadata);
  swapped.properties.solml.role = "client";
  assert.match(sdk.verifyReceipt({ metadata: swapped, irText }).failures.join(), /owner/);
});

test("closed receipts must match the close event", () => {
  const recipient = sdk.receiptRecipients(out.ir)[0];
  const closed = {
    escrow: sdk.escrowPda(out.termsHash), termsHash: out.termsHash, state: 5, fault: 0, clientStrike: false,
    toService: 6_000_000_000n, toClient: 1_000_000_000n, toGuarantors: 200_000_000n, toTreasury: 100_000_000n,
  };
  const metadata = sdk.buildReceiptMetadata({ ir: out.ir, recipient, irUri, closed });
  assert.equal(metadata.properties.solml.outcome.state, "Completed");
  assert.ok(sdk.verifyReceipt({ metadata, irText, closed }).ok);
  assert.equal(sdk.verifyReceipt({ metadata, irText, closed: { ...closed, toClient: 0n } }).ok, false);
});

test("create_escrow for the largest legal contract fits one legacy transaction", () => {
  const keys = Array.from({ length: 7 }, () => Keypair.generate().publicKey.toBase58());
  const m = keys[6];
  const seats = keys.slice(2, 7).map((k) => `<meta name="guarantor" content="wallet:${k}"/>`).join("");
  const checks = Array.from({ length: 6 }, () => `<check mint="${m}" mint-supply="18446744073709551615"/>`).join("");
  const mss = Array.from({ length: 8 }, (_, i) =>
    `<milestone id="milestone-number-${i}" weight="12.5%" deadline="${i + 1}d" release="${i ? "vote" : "checks+vote"}">${i ? "" : checks}</milestone>`).join("");
  const src = `<escrow id="the-largest-contract-allowed-v1" settle="mint:${m}" decimals="9" symbol="MAXTOKEN">${seats}
    <service wallet="${keys[0]}"/><client wallet="${keys[1]}"/><deposit from="client" amount="1"/>${mss}
    <warranty period="30d" hold="30%"/></escrow>`;
  const big = compile({ contract: { file: "max.solml", text: src } });
  const creator = Keypair.generate();
  const tx = new Transaction().add(
    sdk.createEscrowIx({ creator: creator.publicKey, mint: new PublicKey(m), termsBytes: big.termsBytes, termsHash: big.termsHash }),
  );
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.feePayer = creator.publicKey;
  tx.sign(creator);
  const size = tx.serialize().length;
  assert.ok(size <= 1232, `${size} bytes`);
  assert.equal(Buffer.from(encodeTerms(termsFromIR(big.ir))).toString("hex"), Buffer.from(big.termsBytes).toString("hex"));
});
