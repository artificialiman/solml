#!/usr/bin/env node
/**
 * solml — compile contracts and drive the v1 escrow program.
 *
 *   solml init-config --arbiter <key> --treasury <key> --fee-bps <n> --keypair <upgrade-authority> --url <rpc>
 *   solml allow-mint  <mint> --keypair <admin> --url <rpc>
 *   solml build   <contract.solml> [--sss f]... [--out dir] [--token-2022]
 *   solml inspect <escrow> --url <rpc>
 *   solml create  <contract.solml> [--sss f]... --keypair <file> --url <rpc>
 *   solml deposit <escrow> --keypair <file> --url <rpc>
 *   solml verify  <escrow> <milestone> --keypair <file> --url <rpc>
 *   solml vote    <escrow> <milestone> approve|reject --keypair <file> --url <rpc>
 *   solml contest <escrow> <milestone> --keypair <file> --url <rpc>
 *   solml crank   <escrow> --keypair <file> --url <rpc> [--treasury-token <acct>]
 *   solml receipts <contract.solml> [--sss f]... --ir-uri <uri> [--out dir]
 *   solml verify-receipt <metadata.json> <ir.json>
 */
import "./quiet.js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CompileError, compile, formatDiagnostic } from "@solml/compiler";
import type { CompileOutput } from "@solml/compiler";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";
import { decodeConfig } from "./accounts.js";
import { EscrowReader, depositRequired, grossForNet, pendingActions, roleOf, transferFeeOf } from "./client.js";
import {
  allowMintIx,
  initConfigIx,
  MILESTONE_NAMES,
  STATE_NAMES,
  closeIx,
  configPda,
  contestIx,
  crankIx,
  createEscrowIx,
  depositIx,
  escrowPda,
  payoutIx,
  vaultAddress,
  verifyIx,
  voteIx,
} from "./program.js";
import { buildReceiptMetadata, receiptRecipients, verifyReceipt } from "./receipts.js";
import type { ReceiptMetadata } from "./receipts.js";

interface Args {
  pos: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const boolean = ["token-2022"].includes(k);
      const v = boolean ? "true" : (argv[++i] ?? "");
      flags.set(k, [...(flags.get(k) ?? []), v]);
    } else pos.push(a);
  }
  return { pos, flags };
}

const flag = (a: Args, k: string) => a.flags.get(k)?.at(-1);
const need = (a: Args, k: string): string => {
  const v = flag(a, k);
  if (!v) throw new Error(`--${k} is required`);
  return v;
};

function compileFrom(a: Args, file: string): CompileOutput {
  return compile({
    contract: { file, text: readFileSync(file, "utf8") },
    sheets: (a.flags.get("sss") ?? []).map((f) => ({ file: f, text: readFileSync(f, "utf8") })),
  });
}

function keypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: "confirmed" });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  const conn = () => new Connection(need(a, "url"), "confirmed");

  switch (cmd) {
    case "init-config": {
      const payer = keypair(need(a, "keypair"));
      const sig = await send(conn(), payer, [
        initConfigIx({
          admin: payer.publicKey,
          arbiter: new PublicKey(need(a, "arbiter")),
          treasury: new PublicKey(need(a, "treasury")),
          protocolFeeBps: Number(need(a, "fee-bps")),
        }),
      ]);
      console.log(`config ${configPda().toBase58()}\ntx     ${sig}`);
      return 0;
    }
    case "allow-mint": {
      const c = conn();
      const payer = keypair(need(a, "keypair"));
      const mint = new PublicKey(a.pos[0] ?? "");
      const tokenProgram = await new EscrowReader(c).tokenProgramOf(mint);
      console.log(await send(c, payer, [allowMintIx({ admin: payer.publicKey, mint, tokenProgram })]));
      return 0;
    }
    case "build": {
      const out = compileFrom(a, a.pos[0] ?? "");
      const tp = flag(a, "token-2022") ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const escrow = escrowPda(out.termsHash);
      const dir = flag(a, "out") ?? ".";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${out.ir.id}.ir.json`), JSON.stringify(out.ir, null, 2) + "\n");
      writeFileSync(join(dir, `${out.ir.id}.canonical.json`), out.canonical);
      console.log(`id         ${out.ir.id}`);
      console.log(`terms hash ${out.termsHashHex}`);
      console.log(`escrow     ${escrow.toBase58()}`);
      console.log(`vault      ${vaultAddress(new PublicKey(out.ir.settle.mint), escrow, tp).toBase58()}`);
      console.log(`terms      ${out.termsBytes.length} bytes`);
      return 0;
    }
    case "inspect": {
      const r = new EscrowReader(conn());
      const e = await r.escrow(new PublicKey(a.pos[0] ?? ""));
      if (!e) {
        console.log("escrow not found (never created, or closed)");
        return 1;
      }
      console.log(`state      ${STATE_NAMES[e.state]}${e.fault ? " (service fault)" : ""}${e.clientStrike ? " (client strike)" : ""}`);
      console.log(`funded     client ${e.clientFunded} / service ${e.serviceFunded}`);
      console.log(`released   ${e.released}, held ${e.held}`);
      e.milestones.forEach((m, i) => console.log(`milestone ${i}  ${MILESTONE_NAMES[m.status]}  votes ${m.votes.join("")}`));
      const now = BigInt(Math.floor(Date.now() / 1000));
      for (const act of pendingActions(e, now)) console.log(`available  ${JSON.stringify(act)}`);
      return 0;
    }
    case "create": {
      const out = compileFrom(a, a.pos[0] ?? "");
      const payer = keypair(need(a, "keypair"));
      const c = conn();
      const mint = new PublicKey(out.ir.settle.mint);
      const tp = await new EscrowReader(c).tokenProgramOf(mint);
      const sig = await send(c, payer, [
        createEscrowIx({ creator: payer.publicKey, mint, termsBytes: out.termsBytes, termsHash: out.termsHash, tokenProgram: tp }),
      ]);
      console.log(`escrow ${escrowPda(out.termsHash).toBase58()}\ntx     ${sig}`);
      return 0;
    }
    case "deposit": {
      const c = conn();
      const payer = keypair(need(a, "keypair"));
      const escrow = new PublicKey(a.pos[0] ?? "");
      const r = new EscrowReader(c);
      const e = await r.escrow(escrow);
      if (!e) throw new Error("escrow not found");
      const role = roleOf(e, payer.publicKey);
      if (!role) throw new Error("this keypair is neither the client nor the service");
      const mint = new PublicKey(e.terms.settleMint);
      const tp = await r.tokenProgramOf(mint);
      const amount = grossForNet(depositRequired(e, role), await transferFeeOf(c, mint, tp));
      const from = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tp);
      const sig = await send(c, payer, [depositIx({ depositor: payer.publicKey, escrow, mint, from, amount, tokenProgram: tp })]);
      console.log(`deposited ${amount} as ${role}\ntx ${sig}`);
      return 0;
    }
    case "verify": {
      const c = conn();
      const payer = keypair(need(a, "keypair"));
      const escrow = new PublicKey(a.pos[0] ?? "");
      const i = Number(a.pos[1]);
      const e = await new EscrowReader(c).escrow(escrow);
      if (!e) throw new Error("escrow not found");
      const checkMints = e.terms.milestones[i]!.checks.map((k) => new PublicKey(k.mint));
      console.log(await send(c, payer, [verifyIx({ caller: payer.publicKey, escrow, index: i, checkMints })]));
      return 0;
    }
    case "vote": {
      const payer = keypair(need(a, "keypair"));
      const approve = a.pos[2] === "approve";
      if (!approve && a.pos[2] !== "reject") throw new Error("vote must be approve or reject");
      const escrow = new PublicKey(a.pos[0] ?? "");
      console.log(await send(conn(), payer, [voteIx({ guarantor: payer.publicKey, escrow, index: Number(a.pos[1]), approve })]));
      return 0;
    }
    case "contest": {
      const payer = keypair(need(a, "keypair"));
      const escrow = new PublicKey(a.pos[0] ?? "");
      console.log(await send(conn(), payer, [contestIx({ party: payer.publicKey, escrow, index: Number(a.pos[1]) })]));
      return 0;
    }
    case "crank": {
      // Sends every permissionless action now due: cranks, payouts, then close.
      const c = conn();
      const payer = keypair(need(a, "keypair"));
      const escrow = new PublicKey(a.pos[0] ?? "");
      const r = new EscrowReader(c);
      const e = await r.escrow(escrow);
      if (!e) throw new Error("escrow not found");
      const mint = new PublicKey(e.terms.settleMint);
      const tp = await r.tokenProgramOf(mint);
      const ata = (owner: Uint8Array) => getAssociatedTokenAddressSync(mint, new PublicKey(owner), true, tp);
      const now = BigInt((await c.getBlockTime(await c.getSlot())) ?? Math.floor(Date.now() / 1000));
      const acts = pendingActions(e, now);
      if (acts.length === 0) console.log("nothing due");
      for (const act of acts) {
        let ix: TransactionInstruction;
        if (act.kind === "crank") ix = crankIx({ caller: payer.publicKey, escrow, index: act.index });
        else if (act.kind === "payout") ix = payoutIx({ caller: payer.publicKey, escrow, mint, serviceToken: ata(e.terms.service), index: act.index, tokenProgram: tp });
        else {
          const cfgAcc = await c.getAccountInfo(configPda());
          if (!cfgAcc) throw new Error("program config not found");
          const treasury = decodeConfig(cfgAcc.data).treasury;
          const treasuryToken = flag(a, "treasury-token")
            ? new PublicKey(flag(a, "treasury-token")!)
            : getAssociatedTokenAddressSync(mint, treasury, true, tp);
          ix = closeIx({
            caller: payer.publicKey, escrow, creator: e.creator, mint,
            serviceToken: ata(e.terms.service), clientToken: ata(e.terms.client), treasuryToken,
            guarantorTokens: e.terms.guarantors.map(ata), tokenProgram: tp,
          });
        }
        console.log(`${JSON.stringify(act)} → ${await send(c, payer, [ix])}`);
      }
      return 0;
    }
    case "receipts": {
      const out = compileFrom(a, a.pos[0] ?? "");
      const irUri = need(a, "ir-uri");
      const dir = flag(a, "out") ?? ".";
      mkdirSync(dir, { recursive: true });
      for (const rcp of receiptRecipients(out.ir)) {
        const meta = buildReceiptMetadata({ ir: out.ir, recipient: rcp, irUri });
        const f = join(dir, `${out.ir.id}.${rcp.role}${rcp.seat ?? ""}.receipt.json`);
        writeFileSync(f, JSON.stringify(meta, null, 2) + "\n");
        console.log(`${rcp.owner}  ${meta.name}  → ${f}`);
      }
      return 0;
    }
    case "verify-receipt": {
      const metadata = JSON.parse(readFileSync(a.pos[0] ?? "", "utf8")) as ReceiptMetadata;
      const res = verifyReceipt({ metadata, irText: readFileSync(a.pos[1] ?? "", "utf8") });
      console.log(res.ok ? "receipt matches the contract" : res.failures.map((f) => `FAIL ${f}`).join("\n"));
      return res.ok ? 0 : 1;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 17).join("\n"));
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    if (e instanceof CompileError) for (const d of e.diagnostics) console.error(formatDiagnostic(d));
    else console.error((e as Error).message);
    process.exitCode = 1;
  },
);
