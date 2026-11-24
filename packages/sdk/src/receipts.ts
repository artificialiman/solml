/**
 * Receipt protocol v1: one soulbound compressed NFT per role per escrow.
 * The metadata JSON commits to the contract through its terms hash; anyone holding the IR
 * can recompute the hash, the escrow address and the on-chain terms bytes.
 */
import { canonicalJson, encodeTerms, termsFromIR, termsHash, toHex } from "@solml/compiler";
import type { EscrowIR } from "@solml/compiler";
import { PublicKey } from "@solana/web3.js";
import type { EscrowClosedEvent } from "./accounts.js";
import { PROGRAM_ID, STATE_NAMES, escrowPda } from "./program.js";

export const RECEIPT_SYMBOL = "SOLML";
export const RECEIPT_VERSION = 1;

export type ReceiptRole = "service" | "client" | "guarantor";
export type ReceiptPhase = "bound" | "closed";

export interface ReceiptRecipient {
  owner: string;
  role: ReceiptRole;
  seat: number | null;
}

export interface ReceiptOutcome {
  state: string;
  serviceFault: boolean;
  clientStrike: boolean;
  toService: string;
  toClient: string;
  toGuarantors: string;
  toTreasury: string;
}

export interface SolmlReceiptProps {
  version: number;
  escrow: string;
  termsHash: string;
  role: ReceiptRole;
  seat: number | null;
  owner: string;
  irUri: string;
  phase: ReceiptPhase;
  outcome: ReceiptOutcome | null;
}

export interface ReceiptMetadata {
  name: string;
  symbol: string;
  description: string;
  attributes: { trait_type: string; value: string }[];
  properties: {
    category: "receipt";
    files: { uri: string; type: string }[];
    solml: SolmlReceiptProps;
  };
}

/** Everyone who receives a receipt: service, client, then each guarantor seat in order. */
export function receiptRecipients(ir: EscrowIR): ReceiptRecipient[] {
  return [
    { owner: ir.parties.service, role: "service", seat: null },
    { owner: ir.parties.client, role: "client", seat: null },
    ...ir.guarantors.map((g, i) => ({ owner: g, role: "guarantor" as const, seat: i })),
  ];
}

/** cNFT names are capped at 32 bytes. */
export function receiptName(ir: EscrowIR, r: ReceiptRecipient): string {
  const tag = r.role === "guarantor" ? `g${r.seat}` : r.role;
  return `${ir.id.slice(0, 31 - tag.length)} ${tag}`;
}

export function buildReceiptMetadata(a: {
  ir: EscrowIR;
  recipient: ReceiptRecipient;
  irUri: string;
  programId?: PublicKey;
  closed?: EscrowClosedEvent;
}): ReceiptMetadata {
  const hash = termsHash(a.ir);
  const escrow = escrowPda(hash, a.programId ?? PROGRAM_ID).toBase58();
  const outcome: ReceiptOutcome | null = a.closed
    ? {
        state: STATE_NAMES[a.closed.state] ?? String(a.closed.state),
        serviceFault: a.closed.fault === 1,
        clientStrike: a.closed.clientStrike,
        toService: a.closed.toService.toString(),
        toClient: a.closed.toClient.toString(),
        toGuarantors: a.closed.toGuarantors.toString(),
        toTreasury: a.closed.toTreasury.toString(),
      }
    : null;
  if (a.closed && toHex(a.closed.termsHash) !== toHex(hash)) {
    throw new Error("closed event belongs to a different contract");
  }
  const status = outcome ? outcome.state.toLowerCase() : "bound";
  const title = a.ir.info.title || a.ir.id;
  return {
    name: receiptName(a.ir, a.recipient),
    symbol: RECEIPT_SYMBOL,
    description: `SolML escrow receipt (${a.recipient.role}) for "${title}". Terms hash ${toHex(hash)}.`,
    attributes: [
      { trait_type: "role", value: a.recipient.role },
      { trait_type: "escrow", value: escrow },
      { trait_type: "terms_hash", value: toHex(hash) },
      { trait_type: "settle", value: a.ir.settle.symbol },
      { trait_type: "price", value: a.ir.amounts.price },
      { trait_type: "status", value: status },
    ],
    properties: {
      category: "receipt",
      files: [{ uri: a.irUri, type: "application/json" }],
      solml: {
        version: RECEIPT_VERSION,
        escrow,
        termsHash: toHex(hash),
        role: a.recipient.role,
        seat: a.recipient.seat,
        owner: a.recipient.owner,
        irUri: a.irUri,
        phase: a.closed ? "closed" : "bound",
        outcome,
      },
    },
  };
}

export interface VerifyResult {
  ok: boolean;
  failures: string[];
}

/**
 * Checks a receipt against the contract IR it points to.
 * `irText` is the document fetched from the receipt's irUri (pretty or canonical JSON).
 * Optional evidence tightens the check: the escrow's creation-event terms bytes,
 * the close event, and the wallet that holds the receipt.
 */
export function verifyReceipt(a: {
  metadata: ReceiptMetadata;
  irText: string;
  programId?: PublicKey;
  createdTermsBytes?: Uint8Array;
  closed?: EscrowClosedEvent;
  holder?: string;
}): VerifyResult {
  const failures: string[] = [];
  const s = a.metadata.properties?.solml;
  if (!s) return { ok: false, failures: ["metadata has no properties.solml block"] };
  let ir: EscrowIR;
  try {
    ir = JSON.parse(a.irText) as EscrowIR;
    canonicalJson(ir);
  } catch (e) {
    return { ok: false, failures: [`IR is not valid canonical-able JSON: ${(e as Error).message}`] };
  }
  const hash = termsHash(ir);
  if (toHex(hash) !== s.termsHash) failures.push("terms hash of the IR does not match the receipt");
  const escrow = escrowPda(hash, a.programId ?? PROGRAM_ID).toBase58();
  if (escrow !== s.escrow) failures.push("escrow address derived from the IR does not match the receipt");

  const recips = receiptRecipients(ir);
  const match = recips.find((r) => r.role === s.role && r.seat === s.seat);
  if (!match) failures.push(`role ${s.role}${s.seat === null ? "" : ` seat ${s.seat}`} does not exist in the contract`);
  else if (match.owner !== s.owner) failures.push("receipt owner is not the wallet the contract names for this role");
  if (a.holder !== undefined && a.holder !== s.owner) failures.push("receipt is held by a wallet other than its named owner");

  if (a.createdTermsBytes) {
    const mine = encodeTerms(termsFromIR(ir));
    if (toHex(mine) !== toHex(a.createdTermsBytes)) failures.push("on-chain terms bytes differ from the compiled IR");
  }
  if (a.closed) {
    if (toHex(a.closed.termsHash) !== toHex(hash)) failures.push("close event belongs to a different contract");
    const o = s.outcome;
    if (!o) failures.push("escrow is closed but the receipt has no outcome");
    else if (
      o.toService !== a.closed.toService.toString() ||
      o.toClient !== a.closed.toClient.toString() ||
      o.toGuarantors !== a.closed.toGuarantors.toString() ||
      o.toTreasury !== a.closed.toTreasury.toString() ||
      o.clientStrike !== a.closed.clientStrike ||
      o.serviceFault !== (a.closed.fault === 1)
    ) {
      failures.push("receipt outcome differs from the close event");
    }
  }
  return { ok: failures.length === 0, failures };
}
