/**
 * Program constants, PDAs and instruction builders for the SolML v1 escrow program.
 * Account order in every builder matches the Anchor `#[derive(Accounts)]` struct field order
 * in programs/solml_escrow/src/lib.rs.
 */
import { sha256 } from "@noble/hashes/sha256";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("3bNY3MoiTTYZMCg3imcHF1UKGuNJ8M2186uSSvMd8SKV");
export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const ESCROW_LEVEL = 255;

export const EscrowState = {
  Funding: 0,
  Active: 1,
  Warranty: 2,
  WarrantyDispute: 3,
  Faulted: 4,
  Completed: 5,
  Refunded: 6,
} as const;

export const MilestoneStatus = {
  Pending: 0,
  Voting: 1,
  Contestable: 2,
  Disputed: 3,
  Passed: 4,
  Paid: 5,
  Failed: 6,
} as const;

export const STATE_NAMES = Object.fromEntries(Object.entries(EscrowState).map(([k, v]) => [v, k])) as Record<number, string>;
export const MILESTONE_NAMES = Object.fromEntries(Object.entries(MilestoneStatus).map(([k, v]) => [v, k])) as Record<number, string>;

const enc = new TextEncoder();

export function discriminator(kind: "global" | "account" | "event", name: string): Uint8Array {
  return sha256(enc.encode(`${kind}:${name}`)).slice(0, 8);
}

export function configPda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("config")], programId)[0];
}

export function mintAllowPda(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("mint"), mint.toBuffer()], programId)[0];
}

/** The escrow address is fixed by the contract: seeds are ["escrow", terms_hash]. */
export function escrowPda(termsHash: Uint8Array, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("escrow"), termsHash], programId)[0];
}

export function vaultAddress(mint: PublicKey, escrow: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, escrow, true, tokenProgram);
}

export function programDataAddress(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_UPGRADEABLE_LOADER)[0];
}

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

function data(name: string, ...parts: Uint8Array[]): Buffer {
  return Buffer.concat([discriminator("global", name), ...parts]);
}
const u8 = (v: number) => Uint8Array.of(v);
const bool = (v: boolean) => Uint8Array.of(v ? 1 : 0);
const u16 = (v: number) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
function u64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function ix(keys: AccountMeta[], body: Buffer, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data: body });
}

export interface Ctx {
  programId?: PublicKey;
}

export function initConfigIx(
  a: { admin: PublicKey; arbiter: PublicKey; treasury: PublicKey; protocolFeeBps: number } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix(
    [w(a.admin, true), w(configPda(pid)), r(pid), r(programDataAddress(pid)), r(SystemProgram.programId)],
    data("init_config", a.arbiter.toBytes(), a.treasury.toBytes(), u16(a.protocolFeeBps)),
    pid,
  );
}

export function setConfigIx(
  a: { admin: PublicKey; newAdmin: PublicKey; arbiter: PublicKey; treasury: PublicKey; protocolFeeBps: number } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix(
    [r(a.admin, true), w(configPda(pid))],
    data("set_config", a.newAdmin.toBytes(), a.arbiter.toBytes(), a.treasury.toBytes(), u16(a.protocolFeeBps)),
    pid,
  );
}

export function allowMintIx(
  a: { admin: PublicKey; mint: PublicKey; tokenProgram?: PublicKey } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix(
    [
      w(a.admin, true),
      r(configPda(pid)),
      r(a.mint),
      w(mintAllowPda(a.mint, pid)),
      r(a.tokenProgram ?? TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    data("allow_mint"),
    pid,
  );
}

/** `termsBytes` and `termsHash` come from the compiler output (`termsBytes`, `termsHash`). */
export function createEscrowIx(
  a: {
    creator: PublicKey;
    mint: PublicKey;
    termsBytes: Uint8Array;
    termsHash: Uint8Array;
    tokenProgram?: PublicKey;
  } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  const tp = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  const escrow = escrowPda(a.termsHash, pid);
  return ix(
    [
      w(a.creator, true),
      r(configPda(pid)),
      r(mintAllowPda(a.mint, pid)),
      r(a.mint),
      w(escrow),
      w(vaultAddress(a.mint, escrow, tp)),
      r(tp),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    data("create_escrow", a.termsBytes),
    pid,
  );
}

export function depositIx(
  a: {
    depositor: PublicKey;
    escrow: PublicKey;
    mint: PublicKey;
    from: PublicKey;
    amount: bigint;
    tokenProgram?: PublicKey;
  } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  const tp = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  return ix(
    [r(a.depositor, true), w(a.escrow), r(a.mint), w(vaultAddress(a.mint, a.escrow, tp)), w(a.from), r(tp)],
    data("deposit", u64(a.amount)),
    pid,
  );
}

/** `checkMints` must list each check's mint in the milestone's check order. */
export function verifyIx(
  a: { caller: PublicKey; escrow: PublicKey; index: number; checkMints: PublicKey[] } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix([w(a.caller, true), w(a.escrow), ...a.checkMints.map((m) => r(m))], data("verify", u8(a.index)), pid);
}

export function voteIx(
  a: { guarantor: PublicKey; escrow: PublicKey; index: number; approve: boolean } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix([w(a.guarantor, true), w(a.escrow)], data("vote", u8(a.index), bool(a.approve)), pid);
}

export function contestIx(a: { party: PublicKey; escrow: PublicKey; index: number } & Ctx): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix([w(a.party, true), w(a.escrow)], data("contest", u8(a.index)), pid);
}

export function resolveIx(
  a: { arbiter: PublicKey; escrow: PublicKey; index: number; approve: boolean } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix([r(a.arbiter, true), r(configPda(pid)), w(a.escrow)], data("resolve", u8(a.index), bool(a.approve)), pid);
}

/** index = milestone, or ESCROW_LEVEL (255) for funding expiry and warranty end. */
export function crankIx(a: { caller: PublicKey; escrow: PublicKey; index: number } & Ctx): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix([w(a.caller, true), w(a.escrow)], data("crank", u8(a.index)), pid);
}

export function payoutIx(
  a: {
    caller: PublicKey;
    escrow: PublicKey;
    mint: PublicKey;
    serviceToken: PublicKey;
    index: number;
    tokenProgram?: PublicKey;
  } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  const tp = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  return ix(
    [w(a.caller, true), w(a.escrow), r(a.mint), w(vaultAddress(a.mint, a.escrow, tp)), w(a.serviceToken), r(tp)],
    data("payout", u8(a.index)),
    pid,
  );
}

export function claimWarrantyIx(a: { client: PublicKey; escrow: PublicKey } & Ctx): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix([w(a.client, true), w(a.escrow)], data("claim_warranty"), pid);
}

export function resolveWarrantyIx(
  a: { arbiter: PublicKey; escrow: PublicKey; uphold: boolean } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  return ix([r(a.arbiter, true), r(configPda(pid)), w(a.escrow)], data("resolve_warranty", bool(a.uphold)), pid);
}

/** `guarantorTokens` must hold one token account per guarantor seat, in seat order. */
export function closeIx(
  a: {
    caller: PublicKey;
    escrow: PublicKey;
    creator: PublicKey;
    mint: PublicKey;
    serviceToken: PublicKey;
    clientToken: PublicKey;
    treasuryToken: PublicKey;
    guarantorTokens: PublicKey[];
    tokenProgram?: PublicKey;
  } & Ctx,
): TransactionInstruction {
  const pid = a.programId ?? PROGRAM_ID;
  const tp = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  return ix(
    [
      r(a.caller, true),
      w(a.escrow),
      w(a.creator),
      r(configPda(pid)),
      r(mintAllowPda(a.mint, pid)),
      r(a.mint),
      w(vaultAddress(a.mint, a.escrow, tp)),
      w(a.serviceToken),
      w(a.clientToken),
      w(a.treasuryToken),
      r(tp),
      ...a.guarantorTokens.map((g) => w(g)),
    ],
    data("close"),
    pid,
  );
}
