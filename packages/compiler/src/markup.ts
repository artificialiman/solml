/**
 * SolML markup parser. A strict XML subset:
 * elements, quoted attributes, self-closing tags, text, comments.
 * No processing instructions, CDATA, DOCTYPE or namespaces.
 */
import type { Loc } from "./diagnostics.js";
import { Reporter } from "./diagnostics.js";

export interface Attr {
  name: string;
  value: string;
  loc: Loc;
}

export interface Element {
  name: string;
  attrs: Map<string, Attr>;
  children: Element[];
  /** Concatenated text content, entity-decoded, whitespace preserved. */
  text: string;
  loc: Loc;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const NAME = /[A-Za-z][A-Za-z0-9_-]*/y;

export function parseMarkup(src: string, file: string, rep: Reporter): Element | null {
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
  const startsWith = (s: string) => src.startsWith(s, i);
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i]!)) advance(1);
  };
  const readName = (): string | null => {
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (!m) return null;
    advance(m[0].length);
    return m[0];
  };
  const decode = (raw: string, at: Loc): string =>
    raw.replace(/&([a-z]+);|&/g, (whole, name: string | undefined) => {
      if (name && ENTITIES[name] !== undefined) return ENTITIES[name]!;
      rep.error("E_MARKUP", `unknown or bare entity '${whole}'`, at);
      return whole;
    });
  const skipMisc = () => {
    for (;;) {
      skipWs();
      if (startsWith("<!--")) {
        const end = src.indexOf("-->", i + 4);
        if (end < 0) {
          rep.error("E_MARKUP", "unterminated comment", loc());
          i = src.length;
          return;
        }
        advance(end + 3 - i);
      } else return;
    }
  };

  const parseElement = (): Element | null => {
    const at = loc();
    if (src[i] !== "<") {
      rep.error("E_MARKUP", "expected '<'", at);
      return null;
    }
    advance(1);
    const name = readName();
    if (!name) {
      rep.error("E_MARKUP", "expected element name", loc());
      return null;
    }
    const el: Element = { name, attrs: new Map(), children: [], text: "", loc: at };
    for (;;) {
      skipWs();
      if (startsWith("/>")) {
        advance(2);
        return el;
      }
      if (src[i] === ">") {
        advance(1);
        break;
      }
      const aLoc = loc();
      const aName = readName();
      if (!aName) {
        rep.error("E_MARKUP", `malformed attribute in <${name}>`, aLoc);
        return null;
      }
      skipWs();
      if (src[i] !== "=") {
        rep.error("E_MARKUP", `attribute '${aName}' needs a quoted value`, aLoc);
        return null;
      }
      advance(1);
      skipWs();
      const q = src[i];
      if (q !== '"' && q !== "'") {
        rep.error("E_MARKUP", `attribute '${aName}' value must be quoted`, loc());
        return null;
      }
      const end = src.indexOf(q, i + 1);
      if (end < 0) {
        rep.error("E_MARKUP", `unterminated value for '${aName}'`, aLoc);
        return null;
      }
      const raw = src.slice(i + 1, end);
      advance(end + 1 - i);
      if (el.attrs.has(aName)) rep.error("E_DUP_ATTR", `duplicate attribute '${aName}'`, aLoc);
      el.attrs.set(aName, { name: aName, value: decode(raw, aLoc), loc: aLoc });
    }
    // content
    for (;;) {
      if (i >= src.length) {
        rep.error("E_MARKUP", `<${name}> is never closed`, at);
        return null;
      }
      if (startsWith("<!--")) {
        skipMisc();
        continue;
      }
      if (startsWith("</")) {
        const cLoc = loc();
        advance(2);
        const close = readName();
        skipWs();
        if (src[i] !== ">") {
          rep.error("E_MARKUP", "malformed closing tag", cLoc);
          return null;
        }
        advance(1);
        if (close !== name) {
          rep.error("E_MARKUP", `expected </${name}>, found </${close ?? ""}>`, cLoc);
          return null;
        }
        return el;
      }
      if (src[i] === "<") {
        const child = parseElement();
        if (!child) return null;
        el.children.push(child);
        continue;
      }
      const tLoc = loc();
      const next = src.indexOf("<", i);
      const stop = next < 0 ? src.length : next;
      el.text += decode(src.slice(i, stop), tLoc);
      advance(stop - i);
    }
  };

  skipMisc();
  if (i >= src.length) {
    rep.error("E_MARKUP", "empty document", loc());
    return null;
  }
  const root = parseElement();
  if (!root) return null;
  skipMisc();
  if (i < src.length) rep.error("E_MARKUP", "content after the root element", loc());
  return root;
}
