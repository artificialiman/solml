/** Program-derived addresses without @solana/web3.js, so the page stays small on slow networks. */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58Decode, base58Encode } from "@solml/compiler";

export const PROGRAM_ID = "3bNY3MoiTTYZMCg3imcHF1UKGuNJ8M2186uSSvMd8SKV";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function key(s: string): Uint8Array {
  const b = base58Decode(s);
  if (!b || b.length !== 32) throw new Error(`bad key ${s}`);
  return b;
}

function onCurve(b: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(b);
    return true;
  } catch {
    return false;
  }
}

export function findPda(seeds: Uint8Array[], programId: string): string {
  const pid = key(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), pid, MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const h = sha256(buf);
    if (!onCurve(h)) return base58Encode(h);
  }
  throw new Error("no viable bump");
}

export function escrowAddress(termsHash: Uint8Array): string {
  return findPda([new TextEncoder().encode("escrow"), termsHash], PROGRAM_ID);
}

export function vaultAddress(mint: string, escrow: string): string {
  return findPda([key(escrow), key(TOKEN_PROGRAM), key(mint)], ATA_PROGRAM);
}
