/**
 * Unit parsing. Every value that reaches the IR is an integer:
 * seconds (u32), basis points (u16), base units (u64 as bigint), lamports (u64 as bigint).
 * No floating point is used anywhere.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = Object.fromEntries([...B58].map((c, i) => [c, i]));

export const U16_MAX = 0xffff;
export const U32_MAX = 0xffffffff;
export const U64_MAX = (1n << 64n) - 1n;

export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP[c];
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

/** A Solana public key: base58 text that decodes to exactly 32 bytes. */
export function parsePubkey(s: string): Uint8Array | null {
  const b = base58Decode(s.trim());
  return b && b.length === 32 ? b : null;
}

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** "90s", "15m", "72h", "7d", "2w" → seconds. Returns null when malformed or above u32. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*([smhdw])$/.exec(s.trim());
  if (!m) return null;
  const unit = DURATION_UNITS[m[2]!]!;
  const v = BigInt(m[1]!) * BigInt(unit);
  return v > BigInt(U32_MAX) ? null : Number(v);
}

/** "20%", "2.5%", "250bps" → basis points (0..=10000). */
export function parseRate(s: string): number | null {
  const t = s.trim();
  let m = /^(\d+)bps$/.exec(t);
  if (m) {
    const v = Number(m[1]);
    return v <= 10000 ? v : null;
  }
  m = /^(\d+)(?:\.(\d{1,2}))?%$/.exec(t);
  if (m) {
    const whole = BigInt(m[1]!);
    const frac = BigInt((m[2] ?? "").padEnd(2, "0"));
    const v = whole * 100n + frac;
    return v <= 10000n ? Number(v) : null;
  }
  return null;
}

/** Non-negative integer that fits u64. */
export function parseU64(s: string): bigint | null {
  const t = s.trim().replace(/_/g, "");
  if (!/^\d+$/.test(t)) return null;
  const v = BigInt(t);
  return v <= U64_MAX ? v : null;
}

export type AmountError = "malformed" | "symbol" | "precision" | "overflow";

/**
 * "20000", "20000 USDC", "1.5 SOL" → base units.
 * The symbol, when present, must equal the settlement symbol.
 */
export function parseAmount(
  s: string,
  decimals: number,
  symbol: string,
): { value: bigint } | { error: AmountError } {
  const m = /^(\d[\d_]*)(?:\.(\d+))?(?:\s+([A-Za-z][A-Za-z0-9]*))?$/.exec(s.trim());
  if (!m) return { error: "malformed" };
  if (m[3] !== undefined && m[3] !== symbol) return { error: "symbol" };
  const frac = m[2] ?? "";
  if (frac.length > decimals) return { error: "precision" };
  const whole = BigInt(m[1]!.replace(/_/g, ""));
  const v = whole * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return v > U64_MAX ? { error: "overflow" } : { value: v };
}

/** Lowercase slug used for escrow and milestone ids. */
export function isSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(s);
}
