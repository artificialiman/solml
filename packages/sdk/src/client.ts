/** Higher-level helpers: fees, wrapped SOL, and the action planner a crank bot runs. */
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { EscrowAccount } from "./accounts.js";
import { clientRequired, decodeConfig, decodeEscrow, decodeMintAllow } from "./accounts.js";
import { ESCROW_LEVEL, EscrowState, MilestoneStatus, PROGRAM_ID, configPda, mintAllowPda } from "./program.js";

export interface TransferFee {
  bps: number;
  max: bigint;
}

export function feeOf(amount: bigint, fee: TransferFee | null): bigint {
  if (!fee || fee.bps === 0 || amount === 0n) return 0n;
  const f = (amount * BigInt(fee.bps) + 9999n) / 10000n;
  return f > fee.max ? fee.max : f;
}

/** Smallest amount to send so the vault is credited at least `net` after a Token-2022 transfer fee. */
export function grossForNet(net: bigint, fee: TransferFee | null): bigint {
  if (!fee || fee.bps === 0) return net;
  let g = net + feeOf(net, fee);
  while (g - feeOf(g, fee) < net) g += 1n;
  while (g > net && g - 1n - feeOf(g - 1n, fee) >= net) g -= 1n;
  return g;
}

export async function transferFeeOf(
  connection: Connection,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<TransferFee | null> {
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const m = await getMint(connection, mint, "confirmed", tokenProgram);
  const cfg = getTransferFeeConfig(m);
  if (!cfg) return null;
  const epoch = BigInt((await connection.getEpochInfo()).epoch);
  const f = epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
  return { bps: f.transferFeeBasisPoints, max: f.maximumFee };
}

/** Wrap lamports into the owner's wrapped-SOL account so SOL settles through the token program. */
export function wrapSolIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
    createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
  ];
}

export type Role = "client" | "service";

export function roleOf(e: EscrowAccount, wallet: PublicKey): Role | null {
  if (new PublicKey(e.terms.client).equals(wallet)) return "client";
  if (new PublicKey(e.terms.service).equals(wallet)) return "service";
  return null;
}

/** Net amount the vault must be credited for this side. */
export function depositRequired(e: EscrowAccount, role: Role): bigint {
  return role === "client" ? clientRequired(e) : e.terms.serviceBond;
}

export type Action =
  | { kind: "crank"; index: number; reason: string }
  | { kind: "payout"; index: number }
  | { kind: "close" };

/**
 * Everything anyone may do now on this escrow without a party's signature.
 * A crank bot runs this per escrow and sends the resulting instructions.
 */
export function pendingActions(e: EscrowAccount, now: bigint): Action[] {
  const out: Action[] = [];
  if (e.state === EscrowState.Funding && now >= e.fundingDeadline) {
    out.push({ kind: "crank", index: ESCROW_LEVEL, reason: "funding window expired" });
  }
  if (e.state === EscrowState.Warranty && now >= e.warrantyEnd) {
    out.push({ kind: "crank", index: ESCROW_LEVEL, reason: "warranty ended" });
  }
  if (e.state === EscrowState.Active) {
    e.milestones.forEach((m, i) => {
      const t = e.terms.milestones[i]!;
      const deadline = e.activatedAt + BigInt(t.deadline);
      if (m.status === MilestoneStatus.Pending && now >= deadline) {
        out.push({ kind: "crank", index: i, reason: "milestone deadline passed" });
      } else if (m.status === MilestoneStatus.Voting && now >= m.voteDeadline && e.dispute === 255) {
        out.push({ kind: "crank", index: i, reason: "vote window closed without a result" });
      } else if (m.status === MilestoneStatus.Contestable && now >= m.contestDeadline) {
        out.push({ kind: "crank", index: i, reason: "contest window closed" });
      }
    });
  }
  if (e.state === EscrowState.Active || e.state === EscrowState.Faulted) {
    e.milestones.forEach((m, i) => {
      if (m.status === MilestoneStatus.Passed) out.push({ kind: "payout", index: i });
    });
  }
  const terminal =
    e.state === EscrowState.Completed || e.state === EscrowState.Faulted || e.state === EscrowState.Refunded;
  if (terminal && !e.milestones.some((m) => m.status === MilestoneStatus.Passed)) out.push({ kind: "close" });
  return out;
}

export class EscrowReader {
  constructor(
    readonly connection: Connection,
    readonly programId: PublicKey = PROGRAM_ID,
  ) {}

  async escrow(address: PublicKey): Promise<EscrowAccount | null> {
    const acc = await this.connection.getAccountInfo(address, "confirmed");
    return acc ? decodeEscrow(acc.data) : null;
  }

  async config() {
    const acc = await this.connection.getAccountInfo(configPda(this.programId), "confirmed");
    return acc ? decodeConfig(acc.data) : null;
  }

  async mintAllow(mint: PublicKey) {
    const acc = await this.connection.getAccountInfo(mintAllowPda(mint, this.programId), "confirmed");
    return acc ? decodeMintAllow(acc.data) : null;
  }

  /** Token program that owns the settlement mint (SPL Token or Token-2022). */
  async tokenProgramOf(mint: PublicKey): Promise<PublicKey> {
    const acc = await this.connection.getAccountInfo(mint, "confirmed");
    if (!acc) throw new Error(`mint ${mint.toBase58()} not found`);
    return acc.owner;
  }
}
