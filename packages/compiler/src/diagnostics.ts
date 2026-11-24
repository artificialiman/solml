/** Location of a token in a source file. Lines and columns start at 1. */
export interface Loc {
  file: string;
  line: number;
  col: number;
}

export interface Diagnostic {
  code: string;
  message: string;
  loc?: Loc;
  /** Second location, e.g. the SSS rule that set a constraint an element broke. */
  related?: Loc;
}

export class CompileError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("\n"));
    this.name = "CompileError";
    this.diagnostics = diagnostics;
  }
}

export function formatLoc(loc: Loc): string {
  return `${loc.file}:${loc.line}:${loc.col}`;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.loc ? `${formatLoc(d.loc)} ` : "";
  const rel = d.related ? ` (rule at ${formatLoc(d.related)})` : "";
  return `${where}${d.code}: ${d.message}${rel}`;
}

/** Collects diagnostics; compilation stops at the end of a phase if any were raised. */
export class Reporter {
  readonly items: Diagnostic[] = [];
  error(code: string, message: string, loc?: Loc, related?: Loc): void {
    const d: Diagnostic = { code, message };
    if (loc) d.loc = loc;
    if (related) d.related = related;
    this.items.push(d);
  }
  get failed(): boolean {
    return this.items.length > 0;
  }
  throwIfFailed(): void {
    if (this.failed) throw new CompileError(this.items);
  }
}
