/**
 * Compact on-chain terms: the Borsh layout `create_escrow` receives.
 * This layout must match `EscrowTerms` in programs/solml_escrow/src/state.rs byte for byte.
 */
import type { CheckKind, EscrowIR, OnMissed, Release } from "./ir.js";
import { termsHash } from "./ir.js";
import { base58Encode, parsePubkey } from "./units.js";

export const TERMS_VERSION = 1;
export const MAX_GUARANTORS = 5;
export const MAX_MILESTONES = 8;
export const MAX_CHECKS = 6;
/** Instruction data budget for create_escrow inside a 1,232-byte transaction. */
export const MAX_TERMS_BYTES = 760;

export const RELEASE_CODE: Record<Release, number> = {
  deadline: 0,
  checks: 1,
  vote: 2,
  "checks+vote": 3,
};
export const ON_MISSED_CODE: Record<OnMissed, number> = { "service-fault": 0, release: 1 };
export const CHECK_CODE: Record<CheckKind, number> = {
  "mint-authority-revoked": 0,
  "freeze-authority-revoked": 1,
  "mint-supply": 2,
};

export interface CheckTerms {
  kind: number;
  mint: Uint8Array;
  value: bigint;
}
export interface MilestoneTerms {
  weightBps: number;
  deadline: number;
  release: number;
  onMissed: number;
  checks: CheckTerms[];
}
export interface EscrowTerms {
  version: number;
  termsHash: Uint8Array;
  settleMint: Uint8Array;
  decimals: number;
  service: Uint8Array;
  client: Uint8Array;
  guarantors: Uint8Array[];
  price: bigint;
  serviceBond: bigint;
  clientBond: bigint;
  guarantorFeeBps: number;
  serviceFaultBps: number;
  clientFaultBps: number;
  warrantyHoldBps: number;
  fundingWindow: number;
  voteWindow: number;
  contestWindow: number;
  warrantyPeriod: number;
  crankTip: bigint;
  milestones: MilestoneTerms[];
}

function pk(s: string): Uint8Array {
  const b = parsePubkey(s);
  if (!b) throw new Error(`invalid public key in IR: ${s}`);
  return b;
}

export function termsFromIR(ir: EscrowIR): EscrowTerms {
  return {
    version: TERMS_VERSION,
    termsHash: termsHash(ir),
    settleMint: pk(ir.settle.mint),
    decimals: ir.settle.decimals,
    service: pk(ir.parties.service),
    client: pk(ir.parties.client),
    guarantors: ir.guarantors.map(pk),
    price: BigInt(ir.amounts.price),
    serviceBond: BigInt(ir.amounts.serviceBond),
    clientBond: BigInt(ir.amounts.clientBond),
    guarantorFeeBps: ir.rates.guarantorFee,
    serviceFaultBps: ir.rates.serviceFaultShare,
    clientFaultBps: ir.rates.clientFaultShare,
    warrantyHoldBps: ir.rates.warrantyHold,
    fundingWindow: ir.windows.funding,
    voteWindow: ir.windows.vote,
    contestWindow: ir.windows.contest,
    warrantyPeriod: ir.windows.warranty,
    crankTip: BigInt(ir.amounts.crankTip),
    milestones: ir.milestones.map((m) => ({
      weightBps: m.weight,
      deadline: m.deadline,
      release: RELEASE_CODE[m.release],
      onMissed: ON_MISSED_CODE[m.onMissed],
      checks: m.checks.map((c) => ({ kind: CHECK_CODE[c.kind], mint: pk(c.mint), value: BigInt(c.value) })),
    })),
  };
}

class Writer {
  private buf: number[] = [];
  u8(v: number) {
    this.buf.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number) {
    for (let k = 0; k < 4; k++) this.u8(v >>> (8 * k));
  }
  u64(v: bigint) {
    for (let k = 0n; k < 8n; k++) this.u8(Number((v >> (8n * k)) & 0xffn));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.u8(x);
  }
  vec<T>(items: T[], f: (t: T) => void) {
    this.u32(items.length);
    items.forEach(f);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

export function encodeTerms(t: EscrowTerms): Uint8Array {
  const w = new Writer();
  w.u8(t.version);
  w.bytes(t.termsHash);
  w.bytes(t.settleMint);
  w.u8(t.decimals);
  w.bytes(t.service);
  w.bytes(t.client);
  w.vec(t.guarantors, (g) => w.bytes(g));
  w.u64(t.price);
  w.u64(t.serviceBond);
  w.u64(t.clientBond);
  w.u16(t.guarantorFeeBps);
  w.u16(t.serviceFaultBps);
  w.u16(t.clientFaultBps);
  w.u16(t.warrantyHoldBps);
  w.u32(t.fundingWindow);
  w.u32(t.voteWindow);
  w.u32(t.contestWindow);
  w.u32(t.warrantyPeriod);
  w.u64(t.crankTip);
  w.vec(t.milestones, (m) => {
    w.u16(m.weightBps);
    w.u32(m.deadline);
    w.u8(m.release);
    w.u8(m.onMissed);
    w.vec(m.checks, (c) => {
      w.u8(c.kind);
      w.bytes(c.mint);
      w.u64(c.value);
    });
  });
  return w.done();
}

export function decodeTerms(data: Uint8Array): { terms: EscrowTerms; size: number } {
  let o = 0;
  const need = (n: number) => {
    if (o + n > data.length) throw new Error("terms data is truncated");
  };
  const u8 = () => {
    need(1);
    return data[o++]!;
  };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const u64 = () => {
    let v = 0n;
    for (let k = 0n; k < 8n; k++) v |= BigInt(u8()) << (8n * k);
    return v;
  };
  const bytes = (n: number) => {
    need(n);
    const b = data.slice(o, o + n);
    o += n;
    return b;
  };
  const vec = <T>(f: () => T, max: number): T[] => {
    const n = u32();
    if (n > max) throw new Error(`vector too long: ${n}`);
    return Array.from({ length: n }, f);
  };
  const terms: EscrowTerms = {
    version: u8(),
    termsHash: bytes(32),
    settleMint: bytes(32),
    decimals: u8(),
    service: bytes(32),
    client: bytes(32),
    guarantors: vec(() => bytes(32), MAX_GUARANTORS),
    price: u64(),
    serviceBond: u64(),
    clientBond: u64(),
    guarantorFeeBps: u16(),
    serviceFaultBps: u16(),
    clientFaultBps: u16(),
    warrantyHoldBps: u16(),
    fundingWindow: u32(),
    voteWindow: u32(),
    contestWindow: u32(),
    warrantyPeriod: u32(),
    crankTip: u64(),
    milestones: vec(
      () => ({
        weightBps: u16(),
        deadline: u32(),
        release: u8(),
        onMissed: u8(),
        checks: vec(() => ({ kind: u8(), mint: bytes(32), value: u64() }), MAX_CHECKS),
      }),
      MAX_MILESTONES,
    ),
  };
  return { terms, size: o };
}

/** Human-readable view of compact terms, used by CLIs and receipt verification. */
export function termsToJson(t: EscrowTerms): Record<string, unknown> {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return {
    version: t.version,
    termsHash: hex(t.termsHash),
    settleMint: base58Encode(t.settleMint),
    decimals: t.decimals,
    service: base58Encode(t.service),
    client: base58Encode(t.client),
    guarantors: t.guarantors.map(base58Encode),
    price: t.price.toString(),
    serviceBond: t.serviceBond.toString(),
    clientBond: t.clientBond.toString(),
    guarantorFeeBps: t.guarantorFeeBps,
    serviceFaultBps: t.serviceFaultBps,
    clientFaultBps: t.clientFaultBps,
    warrantyHoldBps: t.warrantyHoldBps,
    fundingWindow: t.fundingWindow,
    voteWindow: t.voteWindow,
    contestWindow: t.contestWindow,
    warrantyPeriod: t.warrantyPeriod,
    crankTip: t.crankTip.toString(),
    milestones: t.milestones.map((m) => ({
      weightBps: m.weightBps,
      deadline: m.deadline,
      release: m.release,
      onMissed: m.onMissed,
      checks: m.checks.map((c) => ({ kind: c.kind, mint: base58Encode(c.mint), value: c.value.toString() })),
    })),
  };
}
