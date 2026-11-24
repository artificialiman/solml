import "./style.css";
import { marked } from "marked";
import { CompileError, compile, formatLoc, toHex } from "@solml/compiler";
import type { CompileOutput, Diagnostic } from "@solml/compiler";
import { DOCS } from "./docs";
import { EXAMPLES } from "./examples";
import { escrowAddress, vaultAddress } from "./pda";

const REPO = "https://github.com/artificialiman/solml";
const view = document.getElementById("view")!;
const FILES = { contract: "contract.solml", sheet: "style.sss" } as const;
type FileKey = keyof typeof FILES;

// Drafts saved under older keys held the previous sample token name; they are dropped once.
try {
  for (const k of ["solml:contract", "solml:sheet"]) localStorage.removeItem(k);
} catch {
  /* storage unavailable */
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`solml:v2:${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`solml:v2:${k}`, v);
    } catch {
      /* storage unavailable: drafts are kept in memory only */
    }
  },
};

const state = {
  contract: store.get("contract") ?? EXAMPLES[0]!.contract,
  sheet: store.get("sheet") ?? EXAMPLES[0]!.sheet,
  file: "contract" as FileKey,
  tab: "problems" as "problems" | "ir" | "terms",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (id: string, cls = "trail") => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><use href="#${id}"/></svg>`;

// ---------- playground ----------

function renderPlayground(): void {
  view.innerHTML = `
  <section class="play">
    <p class="lead">Edit the contract. Its escrow account on Solana is derived from the terms, so any change to the terms gives a new address.</p>
    <div class="pane editor glass">
      <div class="pane-head">
        <div class="tabs" role="tablist" aria-label="Files">
          ${(Object.keys(FILES) as FileKey[])
            .map((k) => `<button role="tab" class="tab" data-file="${k}" aria-selected="${state.file === k}">${icon("i-file", "lead-i")}${FILES[k]}</button>`)
            .join("")}
        </div>
        <label class="btn picker">
          <span>Load example</span>
          <select id="example" aria-label="Load example">
            <option value="">Choose…</option>
            ${EXAMPLES.map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join("")}
          </select>
          ${icon("i-down")}
        </label>
      </div>
      <div class="code">
        <pre class="gutter" aria-hidden="true"></pre>
        <textarea id="src" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Source"></textarea>
      </div>
    </div>
    <div class="result">
      <div class="seal glass" id="seal"></div>
      <div class="pane glass out">
        <div class="pane-head">
          <div class="tabs" role="tablist" aria-label="Output">
            <button role="tab" class="tab" data-tab="problems">Problems</button>
            <button role="tab" class="tab" data-tab="ir">IR</button>
            <button role="tab" class="tab" data-tab="terms">Terms bytes</button>
          </div>
        </div>
        <div class="out-body" id="out"></div>
      </div>
    </div>
  </section>`;

  const src = view.querySelector<HTMLTextAreaElement>("#src")!;
  const gutter = view.querySelector<HTMLPreElement>(".gutter")!;
  const out = view.querySelector<HTMLDivElement>("#out")!;
  const seal = view.querySelector<HTMLDivElement>("#seal")!;
  let result: CompileOutput | null = null;
  let problems: Diagnostic[] = [];
  let timer = 0;

  const syncGutter = () => {
    const lines = src.value.split("\n").length;
    const bad = new Set(problems.filter((d) => d.loc?.file === FILES[state.file]).map((d) => d.loc!.line));
    gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<span${bad.has(i + 1) ? ' class="bad"' : ""}>${i + 1}</span>`).join("\n");
    gutter.scrollTop = src.scrollTop;
  };

  const run = () => {
    try {
      result = compile({
        contract: { file: FILES.contract, text: state.contract },
        sheets: state.sheet.trim() ? [{ file: FILES.sheet, text: state.sheet }] : [],
      });
      problems = [];
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      result = null;
      problems = e.diagnostics;
    }
    renderSeal();
    renderOut();
    syncGutter();
  };

  const renderSeal = () => {
    if (!result) {
      seal.classList.add("void");
      seal.innerHTML = `
        <svg class="wm" viewBox="0 0 32 32" aria-hidden="true"><use href="#g-seal"/></svg>
        <p class="seal-label">Escrow account</p>
        <p class="seal-none">No account yet. ${problems.length} ${problems.length === 1 ? "problem" : "problems"} to fix.</p>`;
      return;
    }
    seal.classList.remove("void");
    const ir = result.ir;
    const escrow = escrowAddress(result.termsHash);
    const vault = vaultAddress(ir.settle.mint, escrow);
    const price = Number(BigInt(ir.amounts.price)) / 10 ** ir.settle.decimals;
    seal.innerHTML = `
      <svg class="wm" viewBox="0 0 32 32" aria-hidden="true"><use href="#g-seal"/></svg>
      <p class="seal-label">Escrow account</p>
      <p class="addr" id="addr">${escrow}</p>
      <button class="btn ghost" id="copy"><span>Copy address</span>${icon("i-copy")}</button>
      <dl class="facts">
        <div><dt>Price</dt><dd>${price.toLocaleString(undefined, { maximumFractionDigits: ir.settle.decimals })} ${esc(ir.settle.symbol)}</dd></div>
        <div><dt>Milestones</dt><dd>${ir.milestones.length}</dd></div>
        <div><dt>Guarantor seats</dt><dd>${ir.guarantors.length}</dd></div>
        <div><dt>Terms size</dt><dd>${result.termsBytes.length} bytes</dd></div>
        <div class="wide"><dt>Terms hash</dt><dd class="mono">${result.termsHashHex}</dd></div>
        <div class="wide"><dt>Vault</dt><dd class="mono">${vault}</dd></div>
      </dl>`;
    seal.querySelector("#copy")!.addEventListener("click", async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement;
      try {
        await navigator.clipboard.writeText(escrow);
        b.innerHTML = `<span>Copied</span>${icon("i-check")}`;
      } catch {
        b.innerHTML = `<span>Select and copy the address</span>`;
      }
      setTimeout(() => (b.innerHTML = `<span>Copy address</span>${icon("i-copy")}`), 1600);
    });
  };

  const renderOut = () => {
    view.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
      if (b.dataset.tab === "problems") b.textContent = problems.length ? `Problems (${problems.length})` : "Problems";
    });
    if (state.tab === "problems") {
      out.innerHTML = problems.length
        ? `<ul class="problems">${problems
            .map(
              (d, i) => `<li><button class="prob" data-i="${i}">
                <span class="where">${d.loc ? esc(`${d.loc.file}:${d.loc.line}:${d.loc.col}`) : ""}</span>
                <span class="code-tag">${d.code}</span>
                <span class="msg">${esc(d.message)}${d.related ? ` <span class="rel">set by ${esc(formatLoc(d.related))}</span>` : ""}</span>
              </button></li>`,
            )
            .join("")}</ul>`
        : `<p class="clean">${icon("i-check", "ok")} Compiles. The program will accept these terms.</p>`;
      out.querySelectorAll<HTMLButtonElement>(".prob").forEach((b) =>
        b.addEventListener("click", () => jumpTo(problems[Number(b.dataset.i)]!)),
      );
    } else if (state.tab === "ir") {
      out.innerHTML = result ? `<pre class="dump">${esc(JSON.stringify(result.ir, null, 2))}</pre>` : `<p class="clean">The IR appears once the contract compiles.</p>`;
    } else {
      out.innerHTML = result
        ? `<p class="note">Borsh data passed to <code>create_escrow</code>, ${result.termsBytes.length} bytes.</p><pre class="dump hex">${toHex(result.termsBytes).replace(/(.{64})/g, "$1\n")}</pre>`
        : `<p class="clean">Terms bytes appear once the contract compiles.</p>`;
    }
  };

  const jumpTo = (d: Diagnostic) => {
    if (!d.loc) return;
    const key = (Object.keys(FILES) as FileKey[]).find((k) => FILES[k] === d.loc!.file);
    if (!key) return;
    if (key !== state.file) switchFile(key);
    const lines = src.value.split("\n");
    let pos = 0;
    for (let i = 0; i < d.loc.line - 1 && i < lines.length; i++) pos += lines[i]!.length + 1;
    pos += Math.max(0, d.loc.col - 1);
    src.focus();
    src.setSelectionRange(pos, pos + Math.max(1, (lines[d.loc.line - 1] ?? "").length - d.loc.col + 1));
    src.scrollTop = Math.max(0, (d.loc.line - 4) * 21);
    syncGutter();
  };

  const switchFile = (k: FileKey) => {
    state.file = k;
    src.value = state[k];
    view.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.file === k)));
    syncGutter();
  };

  src.addEventListener("input", () => {
    state[state.file] = src.value;
    store.set(state.file, src.value);
    syncGutter();
    clearTimeout(timer);
    timer = window.setTimeout(run, 140);
  });
  src.addEventListener("scroll", () => (gutter.scrollTop = src.scrollTop));
  src.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      src.setRangeText("  ", src.selectionStart, src.selectionEnd, "end");
      src.dispatchEvent(new Event("input"));
    }
  });
  view.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((b) =>
    b.addEventListener("click", () => switchFile(b.dataset.file as FileKey)),
  );
  view.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab as typeof state.tab;
      renderOut();
    }),
  );
  view.querySelector<HTMLSelectElement>("#example")!.addEventListener("change", (e) => {
    const sel = e.currentTarget as HTMLSelectElement;
    const ex = EXAMPLES.find((x) => x.id === sel.value);
    sel.value = "";
    if (!ex) return;
    state.contract = ex.contract;
    state.sheet = ex.sheet;
    store.set("contract", ex.contract);
    store.set("sheet", ex.sheet);
    state.tab = "problems";
    switchFile("contract");
    run();
  });

  switchFile(state.file);
  run();
}

// ---------- docs ----------

function renderDocs(slug: string): void {
  const doc = DOCS.find((d) => d.slug === slug) ?? DOCS[0]!;
  const html = marked.parse(doc.md, { async: false }) as string;
  view.innerHTML = `
  <section class="docs">
    <nav class="doc-nav glass" aria-label="Specification">
      ${DOCS.map((d) => `<a href="#/docs/${d.slug}"${d.slug === doc.slug ? ' aria-current="page"' : ""}>${d.title}</a>`).join("")}
    </nav>
    <article class="doc glass">${html}</article>
  </section>`;
  view.querySelectorAll<HTMLAnchorElement>(".doc a[href]").forEach((a) => {
    const href = a.getAttribute("href")!;
    const target = DOCS.find((d) => d.file === href);
    if (target) a.setAttribute("href", `#/docs/${target.slug}`);
    else if (!/^(https?:|#)/.test(href)) a.setAttribute("href", `${REPO}/blob/main/spec/${href}`);
  });
  view.querySelectorAll(".doc table").forEach((t) => {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });
  window.scrollTo(0, 0);
}

// ---------- routing ----------

function route(): void {
  const h = location.hash.replace(/^#/, "") || "/";
  const docs = /^\/docs\/?([\w-]*)/.exec(h);
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === (docs ? "docs" : "play");
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (docs) renderDocs(docs[1] || "language");
  else renderPlayground();
}

window.addEventListener("hashchange", route);
route();
