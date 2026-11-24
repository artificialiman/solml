#!/usr/bin/env node
/**
 * solmlc — compile a SolML contract.
 *   solmlc <contract.solml> [--sss sheet.sss]... [--out dir]
 * Writes <id>.ir.json (pretty), <id>.canonical.json (hashed bytes), <id>.terms.hex (create_escrow data).
 * Exit code 1 on compile errors, printed as file:line:col CODE: message.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CompileError, formatDiagnostic } from "./diagnostics.js";
import { compile } from "./compile.js";
import { toHex } from "./ir.js";

function main(argv: string[]): number {
  const sheets: string[] = [];
  let out: string | undefined;
  let contract: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--sss") sheets.push(argv[++i] ?? "");
    else if (a === "--out") out = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: solmlc <contract.solml> [--sss sheet.sss]... [--out dir]");
      return 0;
    } else contract = a;
  }
  if (!contract) {
    console.error("usage: solmlc <contract.solml> [--sss sheet.sss]... [--out dir]");
    return 2;
  }
  try {
    const res = compile({
      contract: { file: contract, text: readFileSync(contract, "utf8") },
      sheets: sheets.map((f) => ({ file: f, text: readFileSync(f, "utf8") })),
    });
    const dir = out ?? ".";
    mkdirSync(dir, { recursive: true });
    const base = join(dir, res.ir.id);
    writeFileSync(`${base}.ir.json`, JSON.stringify(res.ir, null, 2) + "\n");
    writeFileSync(`${base}.canonical.json`, res.canonical);
    writeFileSync(`${base}.terms.hex`, toHex(res.termsBytes) + "\n");
    console.log(`id          ${res.ir.id}`);
    console.log(`terms hash  ${res.termsHashHex}`);
    console.log(`terms size  ${res.termsBytes.length} bytes`);
    console.log(`wrote       ${base}.ir.json, .canonical.json, .terms.hex`);
    return 0;
  } catch (e) {
    if (e instanceof CompileError) {
      for (const d of e.diagnostics) console.error(formatDiagnostic(d));
      return 1;
    }
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));
