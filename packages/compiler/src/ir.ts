/**
 * Escrow IR v1: the resolved, canonical form of a contract.
 * Every number is an integer. u64 values are decimal strings so JSON never loses precision.
 * The SHA-256 of the canonical JSON is the contract's terms hash; it also seeds the escrow address.
 */
import { sha256 } from "@noble/hashes/sha256";

export type Cluster = "mainnet" | "devnet";
export type Release = "deadline" | "checks" | "vote" | "checks+vote";
export type OnMissed = "service-fault" | "release";
export type CheckKind = "mint-authority-revoked" | "freeze-authority-revoked" | "mint-supply";

export interface IrCheck {
  kind: CheckKind;
  mint: string;
  /** Expected supply in base units for mint-supply; "0" otherwise. */
  value: string;
}

export interface IrMilestone {
  id: string;
  /** Basis points of the price. All weights sum to 10000. */
  weight: number;
  /** Seconds after activation. */
  deadline: number;
  release: Release;
  onMissed: OnMissed;
  checks: IrCheck[];
}

export interface EscrowIR {
  solml: 1;
  id: string;
  cluster: Cluster;
  settle: { mint: string; decimals: number; symbol: string };
  parties: { service: string; client: string };
  guarantors: string[];
  amounts: { price: string; serviceBond: string; clientBond: string; crankTip: string };
  rates: {
    guarantorFee: number;
    serviceFaultShare: number;
    clientFaultShare: number;
    warrantyHold: number;
  };
  windows: { funding: number; vote: number; contest: number; warranty: number };
  milestones: IrMilestone[];
  receipt: { format: "cnft"; soulbound: true };
  info: { title: string; deliverables: string[] };
}

/**
 * Canonical JSON: object keys sorted by code point, no insignificant whitespace,
 * integers only, no undefined, no floats. Same input always yields the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error(`non-integer number in IR: ${value}`);
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys
        .map((k) => {
          if (obj[k] === undefined) throw new Error(`undefined value at key '${k}'`);
          return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
        })
        .join(",")}}`;
    }
    default:
      throw new Error(`unsupported value in IR: ${typeof value}`);
  }
}

export function termsHash(ir: EscrowIR): Uint8Array {
  return sha256(new TextEncoder().encode(canonicalJson(ir)));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
