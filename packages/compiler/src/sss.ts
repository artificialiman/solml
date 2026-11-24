/**
 * SSS: SolML Style Sheets. Declares defaults, constraints and failure policy.
 * Syntax is a CSS subset: rules of `selector { property: value; }`, block comments.
 * Selectors: `*`, `type`, `type[attr=value]...`, comma lists. No pseudo-classes, no combinators,
 * no at-rules, no conditionals.
 *
 * Cascade order (later wins): origin (base < sugar < contract), then specificity, then source order.
 * Specificity: `*` = 0, type = 1, each [attr=value] = +10.
 */
import type { Loc } from "./diagnostics.js";
import { Reporter } from "./diagnostics.js";
import { parseDuration, parseRate, parseU64 } from "./units.js";

export type Origin = "base" | "sugar" | "contract";
const ORIGIN_RANK: Record<Origin, number> = { base: 0, sugar: 1, contract: 2 };

export interface Selector {
  type: string; // "*" for universal
  attrs: { name: string; value: string }[];
  specificity: number;
}

export interface Decl {
  prop: string;
  raw: string;
  value: PropValue;
  loc: Loc;
}

export interface Rule {
  selectors: Selector[];
  decls: Decl[];
  origin: Origin;
  order: number;
  loc: Loc;
}

export type PropValue =
  | { kind: "duration"; seconds: number }
  | { kind: "rate"; bps: number }
  | { kind: "lamports"; value: bigint }
  | { kind: "enum"; value: string };

type PropKind = "duration" | "rate" | "lamports" | { enum: string[] };

/** Every property SSS v1 accepts, keyed by the element type it applies to. */
export const SSS_SCHEMA: Record<string, Record<string, PropKind>> = {
  escrow: {
    "funding-window": "duration",
    "max-duration": "duration",
    "guarantor-fee": "rate",
    "crank-tip": "lamports",
    "on-underfund": { enum: ["refund-all"] },
  },
  bond: {
    default: "rate",
    min: "rate",
    max: "rate",
    "fault-share": "rate",
  },
  milestone: {
    "on-deadline-missed": { enum: ["service-fault", "release"] },
    "min-deadline": "duration",
    "max-deadline": "duration",
  },
  vote: {
    window: "duration",
    "contest-window": "duration",
  },
  warranty: {
    "max-period": "duration",
    "max-hold": "rate",
    "on-no-claim": { enum: ["release-hold"] },
  },
};

/** The built-in base sheet. Contract sheets override it through the cascade. */
export const BASE_SHEET = `
escrow {
  funding-window: 7d;
  max-duration: 365d;
  guarantor-fee: 100bps;
  crank-tip: 20000;
  on-underfund: refund-all;
}
bond[from=service] { default: 20%; min: 10%; max: 100%; fault-share: 50%; }
bond[from=client]  { default: 5%;  min: 0%;  max: 20%;  fault-share: 50%; }
milestone {
  on-deadline-missed: service-fault;
  min-deadline: 1h;
  max-deadline: 365d;
}
vote { window: 72h; contest-window: 48h; }
warranty { max-period: 180d; max-hold: 30%; on-no-claim: release-hold; }
`;

/** Injected for the <hold> shorthand: a plain timed transfer carries no bonds. */
export const HOLD_SHEET = `
bond { default: 0%; min: 0%; }
`;

function parseValue(kind: PropKind, raw: string): PropValue | null {
  if (kind === "duration") {
    const s = parseDuration(raw);
    return s === null ? null : { kind: "duration", seconds: s };
  }
  if (kind === "rate") {
    const b = parseRate(raw);
    return b === null ? null : { kind: "rate", bps: b };
  }
  if (kind === "lamports") {
    const v = parseU64(raw);
    return v === null ? null : { kind: "lamports", value: v };
  }
  return kind.enum.includes(raw) ? { kind: "enum", value: raw } : null;
}

function describe(kind: PropKind): string {
  if (typeof kind === "string") return kind;
  return `one of ${kind.enum.join(", ")}`;
}

export function parseSheet(
  src: string,
  file: string,
  origin: Origin,
  rep: Reporter,
  orderStart = 0,
): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const loc = (): Loc => ({ file, line, col });
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) advance(1);
      if (src.startsWith("/*", i)) {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) {
          rep.error("E_SSS_SYNTAX", "unterminated comment", loc());
          advance(src.length - i);
          return;
        }
        advance(end + 2 - i);
      } else return;
    }
  };

  let order = orderStart;
  for (;;) {
    skip();
    if (i >= src.length) break;
    const ruleLoc = loc();
    if (src[i] === "@") {
      rep.error("E_SSS_SYNTAX", "at-rules are not part of SSS v1", ruleLoc);
      return rules;
    }
    const open = src.indexOf("{", i);
    if (open < 0) {
      rep.error("E_SSS_SYNTAX", "expected '{'", ruleLoc);
      return rules;
    }
    const selText = src.slice(i, open);
    advance(open + 1 - i);
    const selectors: Selector[] = [];
    for (const part of selText.split(",")) {
      const sel = parseSelector(part.trim());
      if (!sel) {
        rep.error("E_SSS_SELECTOR", `invalid selector '${part.trim()}'`, ruleLoc);
        continue;
      }
      if (sel.type !== "*" && !SSS_SCHEMA[sel.type]) {
        rep.error(
          "E_SSS_SELECTOR",
          `'${sel.type}' is not a styleable element (use ${Object.keys(SSS_SCHEMA).join(", ")})`,
          ruleLoc,
        );
        continue;
      }
      selectors.push(sel);
    }
    const decls: Decl[] = [];
    for (;;) {
      skip();
      if (i >= src.length) {
        rep.error("E_SSS_SYNTAX", "rule is never closed", ruleLoc);
        return rules;
      }
      if (src[i] === "}") {
        advance(1);
        break;
      }
      const dLoc = loc();
      const m = /^([a-z][a-z-]*)\s*:/.exec(src.slice(i));
      if (!m) {
        rep.error("E_SSS_SYNTAX", "expected 'property: value;'", dLoc);
        return rules;
      }
      advance(m[0].length);
      let j = i;
      while (j < src.length && src[j] !== ";" && src[j] !== "}") j++;
      const raw = src.slice(i, j).trim();
      advance(j - i);
      if (src[i] === ";") advance(1);
      const prop = m[1]!;
      // A property must be valid for every typed selector in the rule.
      let kind: PropKind | undefined;
      let ok = true;
      for (const sel of selectors) {
        const k =
          sel.type === "*"
            ? Object.values(SSS_SCHEMA).find((s) => s[prop])?.[prop]
            : SSS_SCHEMA[sel.type]?.[prop];
        if (!k) {
          rep.error(
            "E_SSS_PROPERTY",
            `unknown property '${prop}' for '${sel.type}'`,
            dLoc,
          );
          ok = false;
          break;
        }
        kind = k;
      }
      if (!ok || !kind) continue;
      const value = parseValue(kind, raw);
      if (!value) {
        rep.error("E_SSS_VALUE", `'${raw}' is not a valid ${describe(kind)} for '${prop}'`, dLoc);
        continue;
      }
      decls.push({ prop, raw, value, loc: dLoc });
    }
    if (selectors.length > 0) rules.push({ selectors, decls, origin, order: order++, loc: ruleLoc });
  }
  return rules;
}

function parseSelector(text: string): Selector | null {
  if (text === "*") return { type: "*", attrs: [], specificity: 0 };
  const m = /^([a-z][a-z-]*)((?:\[[a-z][a-z-]*=(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.+-]+)\])*)$/.exec(text);
  if (!m) return null;
  const attrs: { name: string; value: string }[] = [];
  const re = /\[([a-z][a-z-]*)=(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.+-]+))\]/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(m[2] ?? ""))) {
    attrs.push({ name: a[1]!, value: a[2] ?? a[3] ?? a[4] ?? "" });
  }
  return { type: m[1]!, attrs, specificity: 1 + 10 * attrs.length };
}

/** What the cascade sees of a SolML element. */
export interface Styled {
  type: string;
  attrs: Record<string, string>;
}

export interface Computed {
  value: PropValue;
  raw: string;
  /** Where the winning declaration sits. */
  loc: Loc;
}

export class Cascade {
  constructor(private readonly rules: Rule[]) {}

  get(el: Styled, prop: string): Computed | undefined {
    let best: { rank: [number, number, number]; c: Computed } | undefined;
    for (const rule of this.rules) {
      let spec = -1;
      for (const sel of rule.selectors) {
        if (sel.type !== "*" && sel.type !== el.type) continue;
        if (!sel.attrs.every((a) => el.attrs[a.name] === a.value)) continue;
        spec = Math.max(spec, sel.specificity);
      }
      if (spec < 0) continue;
      for (const d of rule.decls) {
        if (d.prop !== prop) continue;
        const rank: [number, number, number] = [ORIGIN_RANK[rule.origin], spec, rule.order];
        if (!best || compareRank(rank, best.rank) >= 0) {
          best = { rank, c: { value: d.value, raw: d.raw, loc: d.loc } };
        }
      }
    }
    return best?.c;
  }
}

function compareRank(a: [number, number, number], b: [number, number, number]): number {
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k]! - b[k]!;
  return 0;
}
