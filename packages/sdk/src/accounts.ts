/** Decoders for program accounts and events. Layouts follow programs/solml_escrow/src/state.rs. */
import { decodeTerms } from "@solml/compiler";
import type { EscrowTerms } from "@solml/compiler";
import { PublicKey } from "@solana/web3.js";
import { discriminator } from "./program.js";

class Reader {
  o = 0;
  constructor(readonly d: Uint8Array) {}
  private dv = () => new DataView(this.d.buffer, this.d.byteOffset, this.d.byteLength);
  u8() {
    if (this.o + 1 > this.d.length) throw new Error("account data truncated");
    return this.d[this.o++]!;
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    const v = this.dv().getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.dv().getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  u64() {
    const v = this.dv().getBigUint64(this.o, true);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.dv().getBigInt64(this.o, true);
    this.o += 8;
    return v;
  }
  key() {
    const k = new PublicKey(this.d.slice(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  bytes(n: number) {
    const b = this.d.slice(this.o, this.o + n);
    this.o += n;
    return b;
  }
  rest() {
    return this.d.slice(this.o);
  }
}

function expectDisc(data: Uint8Array, kind: "account" | "event", name: string): Reader {
  const disc = discriminator(kind, name);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== disc[i]) throw new Error(`data is not a ${name} ${kind}`);
  }
  const r = new Reader(data);
  r.o = 8;
  return r;
}

export interface ConfigAccount {
  admin: PublicKey;
  arbiter: PublicKey;
  treasury: PublicKey;
  protocolFeeBps: number;
  bump: number;
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  const r = expectDisc(data, "account", "Config");
  return { admin: r.key(), arbiter: r.key(), treasury: r.key(), protocolFeeBps: r.u16(), bump: r.u8() };
}

export interface MintAllowAccount {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  flags: number;
  bump: number;
}

export const MintFlags = { FreezeAuthority: 1, TransferFee: 2, Pausable: 4, Token2022: 8 } as const;

export function decodeMintAllow(data: Uint8Array): MintAllowAccount {
  const r = expectDisc(data, "account", "MintAllow");
  return { mint: r.key(), tokenProgram: r.key(), decimals: r.u8(), flags: r.u8(), bump: r.u8() };
}

export interface MilestoneStateAccount {
  status: number;
  checksPassed: number;
  votes: number[];
  outcome: number;
  voteDeadline: bigint;
  contestDeadline: bigint;
}

export interface EscrowAccount {
  bump: number;
  creator: PublicKey;
  state: number;
  fault: number;
  clientStrike: boolean;
  dispute: number;
  disputedBy: number;
  clientFunded: bigint;
  serviceFunded: bigint;
  protocolFee: bigint;
  guarantorFee: bigint;
  createdAt: bigint;
  fundingDeadline: bigint;
  activatedAt: bigint;
  warrantyEnd: bigint;
  released: bigint;
  held: bigint;
  tipPool: bigint;
  seatOk: number;
  seatBad: number;
  milestones: MilestoneStateAccount[];
  terms: EscrowTerms;
}

export function decodeEscrow(data: Uint8Array): EscrowAccount {
  const r = expectDisc(data, "account", "Escrow");
  const head = {
    bump: r.u8(),
    creator: r.key(),
    state: r.u8(),
    fault: r.u8(),
    clientStrike: r.bool(),
    dispute: r.u8(),
    disputedBy: r.u8(),
    clientFunded: r.u64(),
    serviceFunded: r.u64(),
    protocolFee: r.u64(),
    guarantorFee: r.u64(),
    createdAt: r.i64(),
    fundingDeadline: r.i64(),
    activatedAt: r.i64(),
    warrantyEnd: r.i64(),
    released: r.u64(),
    held: r.u64(),
    tipPool: r.u64(),
    seatOk: r.u8(),
    seatBad: r.u8(),
  };
  const n = r.u32();
  const milestones: MilestoneStateAccount[] = [];
  for (let i = 0; i < n; i++) {
    milestones.push({
      status: r.u8(),
      checksPassed: r.u8(),
      votes: Array.from(r.bytes(5)),
      outcome: r.u8(),
      voteDeadline: r.i64(),
      contestDeadline: r.i64(),
    });
  }
  const { terms } = decodeTerms(r.rest());
  return { ...head, milestones, terms };
}

/** Client deposit requirement: price + protocol fee + guarantor fee + client bond. */
export function clientRequired(e: EscrowAccount): bigint {
  return e.terms.price + e.protocolFee + e.guarantorFee + e.terms.clientBond;
}

// ---- events ----------------------------------------------------------------

export interface EscrowClosedEvent {
  escrow: PublicKey;
  termsHash: Uint8Array;
  state: number;
  fault: number;
  clientStrike: boolean;
  toService: bigint;
  toClient: bigint;
  toGuarantors: bigint;
  toTreasury: bigint;
}

export interface EscrowCreatedEvent {
  escrow: PublicKey;
  creator: PublicKey;
  terms: EscrowTerms;
  /** The exact Borsh bytes of the terms, for byte comparison against a recompiled contract. */
  termsBytes: Uint8Array;
}

export function decodeEscrowClosed(data: Uint8Array): EscrowClosedEvent {
  const r = expectDisc(data, "event", "EscrowClosed");
  return {
    escrow: r.key(),
    termsHash: r.bytes(32),
    state: r.u8(),
    fault: r.u8(),
    clientStrike: r.bool(),
    toService: r.u64(),
    toClient: r.u64(),
    toGuarantors: r.u64(),
    toTreasury: r.u64(),
  };
}

export function decodeEscrowCreated(data: Uint8Array): EscrowCreatedEvent {
  const r = expectDisc(data, "event", "EscrowCreated");
  const escrow = r.key();
  const creator = r.key();
  const rest = r.rest();
  const { terms, size } = decodeTerms(rest);
  return { escrow, creator, terms, termsBytes: rest.slice(0, size) };
}

/** Anchor writes events as `Program data: <base64>` log lines. */
export function eventsFromLogs(logs: string[]): Uint8Array[] {
  return logs
    .filter((l) => l.startsWith("Program data: "))
    .map((l) => Uint8Array.from(Buffer.from(l.slice("Program data: ".length), "base64")));
}

export function findEvent<T>(logs: string[], name: string, decode: (d: Uint8Array) => T): T | undefined {
  const disc = discriminator("event", name);
  for (const d of eventsFromLogs(logs)) {
    if (disc.every((b, i) => d[i] === b)) return decode(d);
  }
  return undefined;
}
