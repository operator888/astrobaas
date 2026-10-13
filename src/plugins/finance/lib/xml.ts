/**
 * A small, strict-enough XML reader for the documents this module consumes:
 * bank statements (camt.053) and incoming e-invoices (CII / UBL).
 *
 * Why not a dependency: those formats are data-only — no DTDs, no entities
 * beyond the five predefined ones, no processing instructions that matter. A
 * reader that refuses DOCTYPE outright is also immune to XXE and billion-laughs
 * by construction, which a general parser has to be configured for.
 *
 * Namespace prefixes are dropped: `ram:CityName` is found as `CityName`. Both
 * camt versions and both e-invoice syntaxes are matched by local name, which
 * is what lets one reader take camt.053.001.02 and .08 alike.
 */

export interface XmlNode {
  name: string; // local name
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e];
  });
}

function local(name: string): string {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

export const XML_MAX_BYTES = 20 * 1024 * 1024;

export function parseXml(input: string): XmlNode {
  if (input.length > XML_MAX_BYTES) throw new Error('XML document is too large.');
  if (/<!DOCTYPE/i.test(input)) throw new Error('XML with a DOCTYPE is refused.');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += decode(input.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decode(input.slice(i, lt));
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('Unterminated comment.');
      i = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('Unterminated CDATA.');
      stack[stack.length - 1].text += input.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (input[lt + 1] === '?') {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('Unterminated processing instruction.');
      i = end + 2;
      continue;
    }
    const gt = findTagEnd(input, lt + 1);
    if (gt === -1) throw new Error('Unterminated tag.');
    const raw = input.slice(lt + 1, gt);
    i = gt + 1;
    if (raw[0] === '/') {
      const name = local(raw.slice(1).trim());
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`Mismatched closing tag </${name}>.`);
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = body.match(/^([^\s/>]+)/);
    if (!m) throw new Error('Malformed tag.');
    const node: XmlNode = { name: local(m[1]), attrs: {}, children: [], text: '' };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(m[1].length);
    while ((a = attrRe.exec(rest))) node.attrs[local(a[1])] = decode(a[3] ?? a[4] ?? '');
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    if (stack.length > 200) throw new Error('XML nesting is too deep.');
  }
  if (stack.length !== 1) throw new Error('Unclosed element at end of document.');
  const doc = root.children[0];
  if (!doc) throw new Error('Empty XML document.');
  return doc;
}

function findTagEnd(s: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

/** First child with this local name. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Follow a path of local names: path(doc, 'Stmt', 'Acct', 'Id', 'IBAN'). */
export function path(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  let cur = node;
  for (const n of names) cur = child(cur, n);
  return cur;
}

export function text(node: XmlNode | undefined): string {
  return node ? node.text.trim() : '';
}

/** Every descendant with this local name, depth-first. */
export function findAll(node: XmlNode | undefined, name: string, out: XmlNode[] = []): XmlNode[] {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
