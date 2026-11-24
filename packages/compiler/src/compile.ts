/**
 * SolML compiler: markup + style sheets → Escrow IR → compact terms.
 *
 * Phases (each stops on error):
 *   1. parse      markup and sheets
 *   2. expand     <hold> shorthand into a full <escrow>
 *   3. resolve    roles, mints, units → integers and keys
 *   4. validate   structure, SSS constraints, program hard bounds
 *   5. emit       canonical IR, terms hash, Borsh terms
 */
import type { Loc } from "./diagnostics.js";
import { CompileError, Reporter } from "./diagnostics.js";
import type { Element } from "./markup.js";
import { parseMarkup } from "./markup.js";
import type { Computed, Rule, Styled } from "./sss.js";
import { BASE_SHEET, Cascade, HOLD_SHEET, parseSheet } from "./sss.js";
import type {
  CheckKind,
  Cluster,
  EscrowIR,
  IrCheck,
  IrMilestone,
  OnMissed,
  Release,
} from "./ir.js";
import { canonicalJson, termsHash, toHex } from "./ir.js";
import type { EscrowTerms } from "./terms.js";
import {
  MAX_CHECKS,
  MAX_GUARANTORS,
  MAX_MILESTONES,
  MAX_TERMS_BYTES,
  encodeTerms,
  termsFromIR,
} from "./terms.js";
import { isSlug, parseAmount, parseDuration, parsePubkey, parseRate, parseU64 } from "./units.js";

/** Program hard bounds. SSS cannot loosen these; the program enforces the same numbers. */
export const HARD = {
  guarantorFeeMaxBps: 500,
  crankTipMin: 5_000n,
  crankTipMax: 1_000_000n,
  windowMin: 3600,
} as const;

export const KNOWN_MINTS: Record<Cluster, Record<string, { mint: string; decimals: number }>> = {
  mainnet: {
    SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
    USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  },
  devnet: {
    SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
    USDC: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
  },
};

export interface Source {
  file: string;
  text: string;
}

export interface CompileInput {
  contract: Source;
  /** Contract style sheets, applied in order after the base sheet. */
  sheets?: Source[];
}

export interface CompileOutput {
  ir: EscrowIR;
  canonical: string;
  termsHash: Uint8Array;
  termsHashHex: string;
  terms: EscrowTerms;
  termsBytes: Uint8Array;
}

const RESERVED_CHECKS = ["pool", "lp", "min-liquidity", "distributor", "root", "vesting"];
const CHECK_PREDICATES: Record<string, CheckKind> = {
  "mint-authority": "mint-authority-revoked",
  "freeze-authority": "freeze-authority-revoked",
  "mint-supply": "mint-supply",
};

const ALLOWED_ATTRS: Record<string, string[]> = {
  escrow: ["id", "settle", "decimals", "symbol", "cluster", "version"],
  hold: ["id", "settle", "decimals", "symbol", "cluster", "version", "from", "to", "amount", "duration"],
  meta: ["name", "content"],
  service: ["wallet"],
  client: ["wallet"],
  deposit: ["from", "amount"],
  bond: ["from", "percent"],
  deliverable: [],
  milestone: ["id", "weight", "deadline", "release"],
  check: ["mint", ...Object.keys(CHECK_PREDICATES), ...RESERVED_CHECKS, "duration"],
  warranty: ["period", "hold"],
  receipt: ["format", "soulbound"],
};

const ROOT_CHILDREN = [
  "meta",
  "service",
  "client",
  "deposit",
  "bond",
  "deliverable",
  "milestone",
  "warranty",
  "receipt",
];

export function compile(input: CompileInput): CompileOutput {
  const rep = new Reporter();

  // 1. parse
  const root = parseMarkup(input.contract.text, input.contract.file, rep);
  rep.throwIfFailed();
  if (!root) throw new CompileError(rep.items);

  let order = 0;
  const rules: Rule[] = [];
  const pushSheet = (text: string, file: string, origin: Rule["origin"]) => {
    const r = parseSheet(text, file, origin, rep, order);
    order += r.length;
    rules.push(...r);
  };
  pushSheet(BASE_SHEET, "<base.sss>", "base");
  if (root.name === "hold") pushSheet(HOLD_SHEET, "<hold.sss>", "sugar");
  for (const s of input.sheets ?? []) pushSheet(s.text, s.file, "contract");
  rep.throwIfFailed();
  const cascade = new Cascade(rules);

  // 2. expand
  let escrow: Element;
  if (root.name === "hold") escrow = expandHold(root, rep);
  else if (root.name === "escrow") escrow = root;
  else {
    rep.error("E_ROOT", `root element must be <escrow> or <hold>, found <${root.name}>`, root.loc);
    throw new CompileError(rep.items);
  }
  rep.throwIfFailed();

  // 3 + 4. resolve and validate
  const ir = resolve(escrow, cascade, rep);
  rep.throwIfFailed();
  if (!ir) throw new CompileError(rep.items);

  // 5. emit
  const canonical = canonicalJson(ir);
  const hash = termsHash(ir);
  const terms = termsFromIR(ir);
  const termsBytes = encodeTerms(terms);
  if (termsBytes.length > MAX_TERMS_BYTES) {
    rep.error(
      "E_TERMS_SIZE",
      `compact terms are ${termsBytes.length} bytes; the limit is ${MAX_TERMS_BYTES} so create_escrow fits one transaction`,
      escrow.loc,
    );
    rep.throwIfFailed();
  }
  return { ir, canonical, termsHash: hash, termsHashHex: toHex(hash), terms, termsBytes };
}

function checkAttrs(el: Element, rep: Reporter): void {
  const allowed = ALLOWED_ATTRS[el.name];
  if (!allowed) return;
  for (const a of el.attrs.values()) {
    if (!allowed.includes(a.name)) {
      rep.error("E_ATTR", `<${el.name}> has no attribute '${a.name}'`, a.loc);
    }
  }
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.get(name)?.value;
}

function attrLoc(el: Element, name: string): Loc {
  return el.attrs.get(name)?.loc ?? el.loc;
}

function requireAttr(el: Element, name: string, rep: Reporter): string | undefined {
  const v = attr(el, name);
  if (v === undefined) rep.error("E_REQUIRED", `<${el.name}> needs '${name}'`, el.loc);
  return v;
}

function synth(name: string, attrs: Record<string, string>, loc: Loc, children: Element[] = []): Element {
  const m = new Map(Object.entries(attrs).map(([k, v]) => [k, { name: k, value: v, loc }]));
  return { name, attrs: m, children, text: "", loc };
}

/** <hold from to amount duration/> → escrow with one deadline-release milestone and no bonds. */
function expandHold(h: Element, rep: Reporter): Element {
  checkAttrs(h, rep);
  for (const c of h.children) {
    if (c.name !== "meta" && c.name !== "deliverable" && c.name !== "receipt") {
      rep.error("E_CHILD", `<hold> may contain only <meta>, <deliverable>, <receipt>; found <${c.name}>`, c.loc);
    }
  }
  const from = requireAttr(h, "from", rep);
  const to = requireAttr(h, "to", rep);
  const amount = requireAttr(h, "amount", rep);
  const duration = requireAttr(h, "duration", rep);
  if (rep.failed) return h;
  const rootAttrs: Record<string, string> = {};
  for (const k of ["id", "settle", "decimals", "symbol", "cluster", "version"]) {
    const v = attr(h, k);
    if (v !== undefined) rootAttrs[k] = v;
  }
  const at = h.loc;
  return synth("escrow", rootAttrs, at, [
    ...h.children,
    synth("service", { wallet: to! }, attrLoc(h, "to")),
    synth("client", { wallet: from! }, attrLoc(h, "from")),
    synth("deposit", { from: "client", amount: amount! }, attrLoc(h, "amount")),
    synth("milestone", { id: "release", weight: "100%", deadline: duration!, release: "deadline" }, attrLoc(h, "duration")),
  ]);
}

function styled(el: Element): Styled {
  const attrs: Record<string, string> = {};
  for (const a of el.attrs.values()) attrs[a.name] = a.value;
  return { type: el.name, attrs };
}

function need(c: Computed | undefined, what: string): Computed {
  if (!c) throw new Error(`base sheet is missing ${what}`);
  return c;
}

function resolve(root: Element, cascade: Cascade, rep: Reporter): EscrowIR | null {
  checkAttrs(root, rep);
  for (const c of root.children) {
    if (!ROOT_CHILDREN.includes(c.name)) {
      rep.error("E_CHILD", `<${c.name}> is not a SolML v1 element`, c.loc);
      continue;
    }
    checkAttrs(c, rep);
    if (c.name !== "milestone" && c.children.length > 0) {
      rep.error("E_CHILD", `<${c.name}> takes no child elements`, c.children[0]!.loc);
    }
    if (c.name !== "deliverable" && c.text.trim() !== "") {
      rep.error("E_TEXT", `<${c.name}> takes no text`, c.loc);
    }
  }
  if (root.text.trim() !== "") rep.error("E_TEXT", "<escrow> takes no text outside elements", root.loc);

  const kids = (name: string) => root.children.filter((c) => c.name === name);
  const one = (name: string, required: boolean): Element | undefined => {
    const list = kids(name);
    if (list.length > 1) rep.error("E_COUNT", `only one <${name}> is allowed`, list[1]!.loc);
    if (required && list.length === 0) rep.error("E_COUNT", `<${name}> is required`, root.loc);
    return list[0];
  };

  // version, id, cluster
  const version = attr(root, "version");
  if (version !== undefined && version !== "1") {
    rep.error("E_VERSION", `this compiler targets SolML 1; found version '${version}'`, attrLoc(root, "version"));
  }
  const id = requireAttr(root, "id", rep) ?? "";
  if (id && !isSlug(id)) {
    rep.error("E_ID", "id must be 1-32 chars of a-z, 0-9 and '-', starting with a letter or digit", attrLoc(root, "id"));
  }
  const clusterRaw = attr(root, "cluster") ?? "mainnet";
  if (clusterRaw !== "mainnet" && clusterRaw !== "devnet") {
    rep.error("E_CLUSTER", "cluster must be 'mainnet' or 'devnet'", attrLoc(root, "cluster"));
  }
  const cluster: Cluster = clusterRaw === "devnet" ? "devnet" : "mainnet";

  // settlement
  const settleRaw = requireAttr(root, "settle", rep) ?? "";
  let settle = { mint: "", decimals: 0, symbol: "" };
  if (settleRaw.startsWith("mint:")) {
    const key = settleRaw.slice(5);
    if (!parsePubkey(key)) rep.error("E_KEY", `'${key}' is not a public key`, attrLoc(root, "settle"));
    const dec = attr(root, "decimals");
    const d = dec === undefined ? null : Number(dec);
    if (d === null || !Number.isInteger(d) || d < 0 || d > 18) {
      rep.error("E_DECIMALS", "a custom settle mint needs decimals=\"0..18\" on the root", root.loc);
    }
    const symbol = attr(root, "symbol") ?? "TOKEN";
    if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(symbol)) {
      rep.error("E_SYMBOL", "symbol must be 1-10 letters or digits, starting with a letter", attrLoc(root, "symbol"));
    }
    settle = { mint: key, decimals: d ?? 0, symbol };
  } else if (settleRaw) {
    const known = KNOWN_MINTS[cluster][settleRaw];
    if (!known) {
      rep.error("E_SETTLE", `settle must be SOL, USDC or mint:<address>; found '${settleRaw}'`, attrLoc(root, "settle"));
    } else {
      if (attr(root, "decimals") !== undefined) {
        rep.error("E_DECIMALS", `decimals is fixed for ${settleRaw}; remove the attribute`, attrLoc(root, "decimals"));
      }
      settle = { mint: known.mint, decimals: known.decimals, symbol: settleRaw };
    }
  }

  // parties
  const keyOf = (el: Element | undefined, name: string): string => {
    if (!el) return "";
    const v = requireAttr(el, name, rep);
    if (v !== undefined && !parsePubkey(v)) rep.error("E_KEY", `'${v}' is not a public key`, attrLoc(el, name));
    return v ?? "";
  };
  const service = keyOf(one("service", true), "wallet");
  const client = keyOf(one("client", true), "wallet");
  if (service && service === client) rep.error("E_PARTIES", "service and client must be different wallets", root.loc);

  // meta: guarantors and title
  const guarantors: string[] = [];
  let title = "";
  for (const m of kids("meta")) {
    const name = requireAttr(m, "name", rep);
    const content = requireAttr(m, "content", rep);
    if (name === undefined || content === undefined) continue;
    if (name === "guarantor") {
      if (content.startsWith("wallet:")) {
        const k = content.slice(7);
        if (!parsePubkey(k)) rep.error("E_KEY", `'${k}' is not a public key`, attrLoc(m, "content"));
        else if (guarantors.includes(k)) rep.error("E_SEAT", "the same wallet holds two guarantor seats", m.loc);
        else if (k === service || k === client) rep.error("E_SEAT", "a party cannot hold a guarantor seat", m.loc);
        else guarantors.push(k);
      } else if (content.startsWith("dex:") || content === "sharks") {
        rep.error(
          "E_SEAT_INACTIVE",
          `guarantor seat '${content}' is reserved; program v1 accepts wallet:<address> seats only`,
          attrLoc(m, "content"),
        );
      } else {
        rep.error("E_SEAT", "guarantor content must be wallet:<address>, dex:<name> or sharks", attrLoc(m, "content"));
      }
    } else if (name === "title") {
      if (title) rep.error("E_COUNT", "only one title", m.loc);
      title = content.trim();
      if (title.length > 120) rep.error("E_TITLE", "title is limited to 120 characters", attrLoc(m, "content"));
    } else {
      rep.error("E_META", `unknown meta name '${name}' (use guarantor or title)`, attrLoc(m, "name"));
    }
  }
  if (guarantors.length > MAX_GUARANTORS) {
    rep.error("E_SEAT", `at most ${MAX_GUARANTORS} guarantor seats`, root.loc);
  }

  // price
  let price = 0n;
  const deposit = one("deposit", true);
  if (deposit) {
    const from = requireAttr(deposit, "from", rep);
    if (from !== undefined && from !== "client") {
      rep.error("E_DEPOSIT", "the price deposit comes from the client; service collateral is a <bond>", attrLoc(deposit, "from"));
    }
    const amt = requireAttr(deposit, "amount", rep);
    if (amt !== undefined && settle.symbol) {
      const r = parseAmount(amt, settle.decimals, settle.symbol);
      if ("error" in r) rep.error("E_AMOUNT", amountMessage(r.error, amt, settle), attrLoc(deposit, "amount"));
      else if (r.value === 0n) rep.error("E_AMOUNT", "price must be above zero", attrLoc(deposit, "amount"));
      else price = r.value;
    }
  }

  // escrow-level policy
  const escrowStyle = styled(root);
  const fundingWindow = need(cascade.get(escrowStyle, "funding-window"), "funding-window");
  const maxDuration = need(cascade.get(escrowStyle, "max-duration"), "max-duration");
  const gFee = need(cascade.get(escrowStyle, "guarantor-fee"), "guarantor-fee");
  const tip = need(cascade.get(escrowStyle, "crank-tip"), "crank-tip");
  const fundingSecs = seconds(fundingWindow);
  if (fundingSecs < HARD.windowMin) rep.error("E_BOUND", "funding-window must be at least 1h", fundingWindow.loc);
  const gFeeBps = bps(gFee);
  if (gFeeBps > HARD.guarantorFeeMaxBps) {
    rep.error("E_BOUND", `guarantor-fee above the program limit of ${HARD.guarantorFeeMaxBps}bps`, gFee.loc);
  }
  const tipLamports = lamports(tip);
  if (tipLamports < HARD.crankTipMin || tipLamports > HARD.crankTipMax) {
    rep.error("E_BOUND", `crank-tip must be ${HARD.crankTipMin}..${HARD.crankTipMax} lamports`, tip.loc);
  }

  // bonds
  const bondRate = (side: "service" | "client"): { amount: bigint; faultShare: number } => {
    const list = kids("bond").filter((b) => attr(b, "from") === side);
    if (list.length > 1) rep.error("E_COUNT", `only one <bond from="${side}">`, list[1]!.loc);
    const el = list[0] ?? synth("bond", { from: side }, root.loc);
    const st = styled(el);
    const min = need(cascade.get(st, "min"), "bond min");
    const max = need(cascade.get(st, "max"), "bond max");
    const share = need(cascade.get(st, "fault-share"), "bond fault-share");
    let rate: number;
    let rateLoc: Loc;
    const pct = attr(el, "percent");
    if (pct !== undefined) {
      const r = parseRate(pct);
      if (r === null) {
        rep.error("E_RATE", `'${pct}' is not a rate (use 20% or 2000bps)`, attrLoc(el, "percent"));
        return { amount: 0n, faultShare: 0 };
      }
      rate = r;
      rateLoc = attrLoc(el, "percent");
    } else {
      const d = need(cascade.get(st, "default"), "bond default");
      rate = bps(d);
      rateLoc = d.loc;
    }
    if (rate < bps(min)) rep.error("E_CONSTRAINT", `${side} bond ${fmtBps(rate)} is below min ${min.raw}`, rateLoc, min.loc);
    if (rate > bps(max)) rep.error("E_CONSTRAINT", `${side} bond ${fmtBps(rate)} is above max ${max.raw}`, rateLoc, max.loc);
    // Bonds round up so they are never smaller than the stated rate.
    const amount = (price * BigInt(rate) + 9999n) / 10000n;
    return { amount, faultShare: bps(share) };
  };
  for (const b of kids("bond")) {
    const from = attr(b, "from");
    if (from !== "service" && from !== "client") {
      rep.error("E_BOND", "bond from must be 'service' or 'client'", attrLoc(b, "from"));
    }
  }
  const sBond = bondRate("service");
  const cBond = bondRate("client");

  // vote policy (virtual element)
  const voteStyle: Styled = { type: "vote", attrs: {} };
  const voteWindow = need(cascade.get(voteStyle, "window"), "vote window");
  const contestWindow = need(cascade.get(voteStyle, "contest-window"), "contest-window");
  if (seconds(voteWindow) < HARD.windowMin) rep.error("E_BOUND", "vote window must be at least 1h", voteWindow.loc);
  if (seconds(contestWindow) < HARD.windowMin) rep.error("E_BOUND", "contest-window must be at least 1h", contestWindow.loc);

  // milestones
  const msEls = kids("milestone");
  if (msEls.length === 0) rep.error("E_COUNT", "at least one <milestone> is required", root.loc);
  if (msEls.length > MAX_MILESTONES) rep.error("E_COUNT", `at most ${MAX_MILESTONES} milestones`, msEls[MAX_MILESTONES]!.loc);
  const milestones: IrMilestone[] = [];
  const ids = new Set<string>();
  let weightSum = 0;
  let checkCount = 0;
  let lastDeadline = 0;
  for (const m of msEls) {
    const mid = requireAttr(m, "id", rep) ?? "";
    if (mid && !isSlug(mid)) rep.error("E_ID", `milestone id '${mid}' must be a lowercase slug`, attrLoc(m, "id"));
    if (ids.has(mid)) rep.error("E_ID", `duplicate milestone id '${mid}'`, attrLoc(m, "id"));
    ids.add(mid);

    const wRaw = requireAttr(m, "weight", rep);
    const w = wRaw === undefined ? null : parseRate(wRaw);
    if (wRaw !== undefined && (w === null || w === 0)) {
      rep.error("E_RATE", `weight '${wRaw}' must be a rate above 0 (e.g. 40%)`, attrLoc(m, "weight"));
    }
    weightSum += w ?? 0;

    const dRaw = requireAttr(m, "deadline", rep);
    const d = dRaw === undefined ? null : parseDuration(dRaw);
    if (dRaw !== undefined && d === null) rep.error("E_DURATION", `'${dRaw}' is not a duration (e.g. 14d)`, attrLoc(m, "deadline"));
    if (d === 0) rep.error("E_BOUND", "a milestone deadline must be above zero", attrLoc(m, "deadline"));
    const st = styled(m);
    const minD = need(cascade.get(st, "min-deadline"), "min-deadline");
    const maxD = need(cascade.get(st, "max-deadline"), "max-deadline");
    if (d !== null && d < seconds(minD)) rep.error("E_CONSTRAINT", `deadline ${dRaw} is below min-deadline ${minD.raw}`, attrLoc(m, "deadline"), minD.loc);
    if (d !== null && d > seconds(maxD)) rep.error("E_CONSTRAINT", `deadline ${dRaw} is above max-deadline ${maxD.raw}`, attrLoc(m, "deadline"), maxD.loc);
    lastDeadline = Math.max(lastDeadline, d ?? 0);

    const checks: IrCheck[] = [];
    for (const c of m.children) {
      if (c.name !== "check") {
        rep.error("E_CHILD", `<milestone> may contain only <check>; found <${c.name}>`, c.loc);
        continue;
      }
      checkAttrs(c, rep);
      const check = resolveCheck(c, rep);
      if (check) checks.push(check);
    }
    checkCount += checks.length;

    const rRaw = attr(m, "release");
    let release: Release;
    if (rRaw === undefined) release = checks.length > 0 ? "checks" : "vote";
    else if (rRaw === "deadline" || rRaw === "checks" || rRaw === "vote" || rRaw === "checks+vote") release = rRaw;
    else {
      rep.error("E_RELEASE", "release must be deadline, checks, vote or checks+vote", attrLoc(m, "release"));
      release = "vote";
    }
    const usesChecks = release === "checks" || release === "checks+vote";
    if (usesChecks && checks.length === 0) rep.error("E_RELEASE", `release '${release}' needs at least one <check>`, m.loc);
    if (!usesChecks && checks.length > 0) rep.error("E_RELEASE", `release '${release}' ignores the <check> elements inside it`, m.loc);
    if ((release === "vote" || release === "checks+vote") && guarantors.length === 0) {
      rep.error("E_RELEASE", `milestone '${mid}' needs a guarantor vote but no guarantor seat is declared`, m.loc);
    }
    const onMissed = need(cascade.get(st, "on-deadline-missed"), "on-deadline-missed");

    milestones.push({
      id: mid,
      weight: w ?? 0,
      deadline: d ?? 0,
      release,
      onMissed: enumValue(onMissed) as OnMissed,
      checks,
    });
  }
  if (msEls.length > 0 && weightSum !== 10000) {
    rep.error("E_WEIGHTS", `milestone weights sum to ${fmtBps(weightSum)}; they must sum to 100%`, msEls[0]!.loc);
  }
  if (checkCount > MAX_CHECKS) rep.error("E_COUNT", `at most ${MAX_CHECKS} checks per escrow`, root.loc);

  // warranty
  const wEl = one("warranty", false);
  let warrantyPeriod = 0;
  let warrantyHold = 0;
  if (wEl) {
    const st = styled(wEl);
    const pRaw = requireAttr(wEl, "period", rep);
    const hRaw = requireAttr(wEl, "hold", rep);
    const p = pRaw === undefined ? null : parseDuration(pRaw);
    const h = hRaw === undefined ? null : parseRate(hRaw);
    if (pRaw !== undefined && (p === null || p === 0)) rep.error("E_DURATION", `warranty period '${pRaw}' is not a duration above 0`, attrLoc(wEl, "period"));
    if (hRaw !== undefined && h === null) rep.error("E_RATE", `warranty hold '${hRaw}' is not a rate`, attrLoc(wEl, "hold"));
    const maxP = need(cascade.get(st, "max-period"), "max-period");
    const maxH = need(cascade.get(st, "max-hold"), "max-hold");
    if (p !== null && p > seconds(maxP)) rep.error("E_CONSTRAINT", `warranty period ${pRaw} is above max-period ${maxP.raw}`, attrLoc(wEl, "period"), maxP.loc);
    if (h !== null && h > bps(maxH)) rep.error("E_CONSTRAINT", `warranty hold ${hRaw} is above max-hold ${maxH.raw}`, attrLoc(wEl, "hold"), maxH.loc);
    warrantyPeriod = p ?? 0;
    warrantyHold = h ?? 0;
  }
  if (lastDeadline + warrantyPeriod > seconds(maxDuration)) {
    rep.error(
      "E_CONSTRAINT",
      `last deadline plus warranty runs ${fmtSecs(lastDeadline + warrantyPeriod)}; max-duration is ${maxDuration.raw}`,
      root.loc,
      maxDuration.loc,
    );
  }

  // receipt
  const rEl = one("receipt", false);
  if (rEl) {
    const f = attr(rEl, "format") ?? "cnft";
    const sb = attr(rEl, "soulbound") ?? "true";
    if (f !== "cnft") rep.error("E_RECEIPT", "receipt format must be 'cnft'", attrLoc(rEl, "format"));
    if (sb !== "true") rep.error("E_RECEIPT", "receipts are soulbound in v1; soulbound must be 'true'", attrLoc(rEl, "soulbound"));
  }

  // deliverables (text, off chain, but committed by the terms hash)
  const deliverables = kids("deliverable")
    .map((d) => d.text.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
  for (const d of kids("deliverable")) {
    if (d.text.trim().length === 0) rep.error("E_TEXT", "<deliverable> is empty", d.loc);
  }

  if (rep.failed) return null;

  return {
    solml: 1,
    id,
    cluster,
    settle,
    parties: { service, client },
    guarantors,
    amounts: {
      price: price.toString(),
      serviceBond: sBond.amount.toString(),
      clientBond: cBond.amount.toString(),
      crankTip: tipLamports.toString(),
    },
    rates: {
      guarantorFee: guarantors.length > 0 ? gFeeBps : 0,
      serviceFaultShare: sBond.faultShare,
      clientFaultShare: cBond.faultShare,
      warrantyHold,
    },
    windows: {
      funding: fundingSecs,
      vote: seconds(voteWindow),
      contest: seconds(contestWindow),
      warranty: warrantyPeriod,
    },
    milestones,
    receipt: { format: "cnft", soulbound: true },
    info: { title, deliverables },
  };
}

function resolveCheck(c: Element, rep: Reporter): IrCheck | null {
  for (const r of RESERVED_CHECKS) {
    if (c.attrs.has(r)) {
      rep.error(
        "E_CHECK_RESERVED",
        `check '${r}' is specified for a later program version; v1 reads mint-authority, freeze-authority, mint-supply`,
        attrLoc(c, r),
      );
      return null;
    }
  }
  const mint = requireAttr(c, "mint", rep);
  if (mint !== undefined && !parsePubkey(mint)) rep.error("E_KEY", `'${mint}' is not a public key`, attrLoc(c, "mint"));
  const preds = Object.keys(CHECK_PREDICATES).filter((p) => c.attrs.has(p));
  if (preds.length !== 1) {
    rep.error("E_CHECK", "a <check> carries exactly one predicate: mint-authority, freeze-authority or mint-supply", c.loc);
    return null;
  }
  const p = preds[0]!;
  const v = attr(c, p)!;
  const kind = CHECK_PREDICATES[p]!;
  let value = "0";
  if (kind === "mint-supply") {
    const n = parseU64(v);
    if (n === null) {
      rep.error("E_CHECK", "mint-supply is an integer in the checked mint's base units", attrLoc(c, p));
      return null;
    }
    value = n.toString();
  } else if (v !== "revoked") {
    rep.error("E_CHECK", `${p} accepts only "revoked"`, attrLoc(c, p));
    return null;
  }
  return mint === undefined ? null : { kind, mint, value };
}

function seconds(c: Computed): number {
  if (c.value.kind !== "duration") throw new Error("expected duration");
  return c.value.seconds;
}
function bps(c: Computed): number {
  if (c.value.kind !== "rate") throw new Error("expected rate");
  return c.value.bps;
}
function lamports(c: Computed): bigint {
  if (c.value.kind !== "lamports") throw new Error("expected lamports");
  return c.value.value;
}
function enumValue(c: Computed): string {
  if (c.value.kind !== "enum") throw new Error("expected enum");
  return c.value.value;
}
function fmtBps(b: number): string {
  return `${b / 100}%`;
}
function fmtSecs(s: number): string {
  return s % 86400 === 0 ? `${s / 86400}d` : `${s}s`;
}
function amountMessage(e: string, raw: string, settle: { decimals: number; symbol: string }): string {
  switch (e) {
    case "symbol":
      return `'${raw}' names a different token; this escrow settles in ${settle.symbol}`;
    case "precision":
      return `'${raw}' has more than ${settle.decimals} decimal places`;
    case "overflow":
      return `'${raw}' does not fit in a u64 of base units`;
    default:
      return `'${raw}' is not an amount (e.g. 20000 or 1.5 ${settle.symbol})`;
  }
}
