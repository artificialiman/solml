import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompileError, compile, canonicalJson, decodeTerms, encodeTerms, parseAmount, parseDuration, parseRate,
  base58Decode, base58Encode, toHex,
} from "../dist/index.js";

const K = {
  s: "CptS4ujvxsFX4pqZB6XekRSqsDsyi6f1RgSEysLT9c1G",
  c: "31CCHqaMqkHnU22qTJdkerwb8FgZFcm3kH1RJPrDbhrz",
  g: "HNsj5CmfrpJUnagwyPYEXA3AFrHc3pumiBVWExJWmCSc",
  m: "CxHuawS9A6mYLy4eVWPZZEdZ85pqwY5ZHtfSgDyqMPq2",
};
const base = (body, attrs = 'settle="USDC"') =>
  `<escrow id="t-1" ${attrs}><service wallet="${K.s}"/><client wallet="${K.c}"/>
   <meta name="guarantor" content="wallet:${K.g}"/><deposit from="client" amount="100"/>${body}</escrow>`;
const ms = `<milestone id="a" weight="100%" deadline="7d"/>`;
const run = (src, ...sheets) =>
  compile({ contract: { file: "c.solml", text: src }, sheets: sheets.map((t, i) => ({ file: `s${i}.sss`, text: t })) });
const codes = (fn) => {
  try { fn(); } catch (e) { if (e instanceof CompileError) return e.diagnostics.map((d) => d.code); throw e; }
  assert.fail("expected compile errors");
};

test("units parse to integers", () => {
  assert.equal(parseDuration("72h"), 259200);
  assert.equal(parseDuration("2w"), 1209600);
  assert.equal(parseDuration("7 days"), null);
  assert.equal(parseRate("2.5%"), 250);
  assert.equal(parseRate("250bps"), 250);
  assert.equal(parseRate("101%"), null);
  assert.deepEqual(parseAmount("1.5 SOL", 9, "SOL"), { value: 1_500_000_000n });
  assert.deepEqual(parseAmount("1_000", 6, "USDC"), { value: 1_000_000_000n });
  assert.deepEqual(parseAmount("1.1234567", 6, "USDC"), { error: "precision" });
  assert.deepEqual(parseAmount("5 SOL", 6, "USDC"), { error: "symbol" });
  assert.deepEqual(parseAmount("18446744073709551616", 0, "X"), { error: "overflow" });
});

test("base58 round trip keeps leading zeros", () => {
  const b = new Uint8Array(32); b[5] = 7;
  assert.deepEqual(base58Decode(base58Encode(b)), b);
});

test("canonical JSON ignores key order and rejects floats", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: "x", c: true }] }), '{"a":[2,{"c":true,"d":"x"}],"b":1}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

test("same contract, different formatting → same terms hash", () => {
  const a = run(base(ms));
  const b = run(base(`
     <milestone   deadline='7d' weight="100%"  id="a" />
     <!-- comment -->`));
  assert.equal(a.termsHashHex, b.termsHashHex);
});

test("cascade: base < contract; attribute selector beats type; later rule wins", () => {
  const src = base(`<milestone id="a" weight="50%" deadline="7d"/><milestone id="b" weight="50%" deadline="8d"/>`);
  const out = run(src,
    `milestone { on-deadline-missed: release; } milestone[id=b] { on-deadline-missed: service-fault; }`,
    `vote { window: 24h; } vote { window: 36h; }`);
  assert.deepEqual(out.ir.milestones.map((m) => m.onMissed), ["release", "service-fault"]);
  assert.equal(out.ir.windows.vote, 36 * 3600);
  assert.equal(out.ir.windows.contest, 48 * 3600, "base sheet value kept");
});

test("bonds: defaults round up; explicit percent checked against SSS bounds", () => {
  const out = run(base(ms).replace('amount="100"', 'amount="0.000003"'));
  assert.equal(out.ir.amounts.serviceBond, "1", "20% of 3 base units rounds up to 1");
  assert.deepEqual(codes(() => run(base(ms + `<bond from="service" percent="5%"/>`))), ["E_CONSTRAINT"]);
  const loose = run(base(ms + `<bond from="service" percent="5%"/>`), "bond[from=service] { min: 0%; }");
  assert.equal(loose.ir.amounts.serviceBond, "5000000");
});

test("SSS cannot loosen program hard bounds", () => {
  assert.deepEqual(codes(() => run(base(ms), "escrow { guarantor-fee: 6%; }")), ["E_BOUND"]);
  assert.deepEqual(codes(() => run(base(ms), "vote { window: 10m; }")), ["E_BOUND"]);
});

test("SSS rejects unknown selectors, properties and values with locations", () => {
  const c = codes(() => run(base(ms), "treasury { x: 1; }\nvote { windw: 1h; }\nvote { window: soon; }\n@media x {}"));
  assert.deepEqual(c, ["E_SSS_SELECTOR", "E_SSS_PROPERTY", "E_SSS_VALUE", "E_SSS_SYNTAX"]);
});

test("release modes must match checks and seats", () => {
  assert.deepEqual(codes(() => run(base(`<milestone id="a" weight="100%" deadline="7d" release="checks"/>`))), ["E_RELEASE"]);
  const noSeat = `<escrow id="t" settle="USDC"><service wallet="${K.s}"/><client wallet="${K.c}"/><deposit from="client" amount="1"/>${ms}</escrow>`;
  assert.deepEqual(codes(() => run(noSeat)), ["E_RELEASE"]);
  const auto = run(base(`<milestone id="a" weight="100%" deadline="7d"><check mint="${K.m}" mint-supply="5"/></milestone>`));
  assert.equal(auto.ir.milestones[0].release, "checks", "release inferred from checks");
});

test("markup errors carry line and column", () => {
  try {
    run(`<escrow id="x" settle="USDC">\n  <service wallet="${K.s}">\n</escrow>`);
    assert.fail();
  } catch (e) {
    assert.equal(e.diagnostics[0].code, "E_MARKUP");
    assert.equal(e.diagnostics[0].loc.line, 3);
  }
});

test("hold shorthand expands to one deadline milestone with no bonds", () => {
  const out = run(`<hold id="h" settle="SOL" from="${K.c}" to="${K.s}" amount="2.5 SOL" duration="3d"/>`);
  assert.equal(out.ir.amounts.price, "2500000000");
  assert.equal(out.ir.amounts.serviceBond, "0");
  assert.equal(out.ir.milestones[0].release, "deadline");
  assert.equal(out.ir.parties.service, K.s);
});

test("custom mint needs decimals; known symbols forbid them", () => {
  assert.ok(codes(() => run(base(ms, `settle="mint:${K.m}"`))).includes("E_DECIMALS"));
  assert.ok(codes(() => run(base(ms, 'settle="USDC" decimals="6"'))).includes("E_DECIMALS"));
});

test("terms bytes round trip and stay inside the transaction budget at maximum size", () => {
  const checks = Array.from({ length: 6 }, () => `<check mint="${K.m}" mint-supply="1"/>`);
  const keys = ["5XXSejMtDvVydV6E4da8Ba4Sp7Eww8tTQsLvCeWAtnVi", "Dy29dmYPrLYnGkctQPt39x1aGicdHg4mN9TMK1bgejQ5", "8Nt1NwSPnZHq7hhGh1ZmyqZWhZQhvWNNjJmdaJYTfkpt", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLD1Lnm4wCbk"];
  const seats = keys.map((k) => `<meta name="guarantor" content="wallet:${k}"/>`).join("");
  const many = Array.from({ length: 8 }, (_, i) =>
    `<milestone id="m${i}" weight="12.5%" deadline="${i + 1}d" release="${i === 0 ? "checks" : "vote"}">${i === 0 ? checks.join("") : ""}</milestone>`).join("");
  const out = run(base(seats + many));
  const { terms, size } = decodeTerms(out.termsBytes);
  assert.equal(size, out.termsBytes.length);
  assert.equal(toHex(encodeTerms(terms)), toHex(out.termsBytes));
  assert.ok(out.termsBytes.length <= 760, `${out.termsBytes.length} bytes`);
});

test("reserved checks and seats point at later program versions", () => {
  const c = codes(() => run(base(`<milestone id="a" weight="100%" deadline="7d"><check mint="${K.m}" lp="locked"/></milestone>`)
    .replace(`wallet:${K.g}`, "dex:raydium")));
  assert.ok(c.includes("E_CHECK_RESERVED") && c.includes("E_SEAT_INACTIVE"));
});
