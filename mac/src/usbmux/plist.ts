// Plist XML (o formato da versão 1 do protocolo do usbmuxd; S2 item 2). Só o subconjunto que o usbmuxd
// usa: dict, array, string, integer, real, true/false, data e date (lida como texto). Sem dependência:
// a constituição (P-2) prefere a biblioteca padrão, e o protocolo é pequeno.

export type PlistValue = string | number | bigint | boolean | Uint8Array | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeValue(value: PlistValue, indent: string, out: string[]): void {
  if (typeof value === 'string') out.push(`${indent}<string>${escapeText(value)}</string>`);
  else if (typeof value === 'bigint') out.push(`${indent}<integer>${value}</integer>`);
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`plist: número não finito (${value})`);
    out.push(Number.isInteger(value) ? `${indent}<integer>${value}</integer>` : `${indent}<real>${value}</real>`);
  } else if (typeof value === 'boolean') out.push(`${indent}<${value}/>`);
  else if (value instanceof Uint8Array) out.push(`${indent}<data>${Buffer.from(value).toString('base64')}</data>`);
  else if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${indent}<array/>`);
      return;
    }
    out.push(`${indent}<array>`);
    for (const item of value) encodeValue(item, `${indent}\t`, out);
    out.push(`${indent}</array>`);
  } else {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.push(`${indent}<dict/>`);
      return;
    }
    out.push(`${indent}<dict>`);
    for (const [key, item] of entries) {
      out.push(`${indent}\t<key>${escapeText(key)}</key>`);
      encodeValue(item, `${indent}\t`, out);
    }
    out.push(`${indent}</dict>`);
  }
}

/** Documento plist XML completo, como o que o `libusbmuxd` manda. */
export function encodePlist(value: PlistValue): string {
  const out: string[] = [];
  encodeValue(value, '', out);
  return `${HEADER}${out.join('\n')}\n</plist>\n`;
}

// ── Leitura ─────────────────────────────────────────────────────────────────────────────────────────

type Token = { kind: 'open' | 'close' | 'empty'; name: string } | { kind: 'text'; text: string };

const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*>|<(\/?)([A-Za-z]+)(?:\s[^<>]*?)?(\/?)>|[^<]+/gy;
const ENTITY = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9A-Fa-f]+));|&/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < xml.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(xml);
    if (m === null) throw new SyntaxError(`plist: XML inesperado na posição ${at}`);
    const [whole, slash, name, selfClose] = m;
    if (name !== undefined) {
      if (slash && selfClose) throw new SyntaxError(`plist: etiqueta inválida ${whole}`);
      tokens.push({ kind: slash ? 'close' : selfClose ? 'empty' : 'open', name });
    } else if (!whole.startsWith('<')) {
      tokens.push({ kind: 'text', text: whole });
    }
  }
  return tokens;
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, named?: string, dec?: string, hex?: string) => {
    if (named) return NAMED[named]!;
    if (dec || hex) return String.fromCodePoint(Number.parseInt(dec ?? hex!, dec ? 10 : 16));
    throw new SyntaxError(`plist: entidade inválida perto de "${whole}"`);
  });
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** Próximo token que não é espaço em branco entre elementos. */
  private next(): Token {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index++]!;
      if (token.kind !== 'text' || token.text.trim() !== '') return token;
    }
    throw new SyntaxError('plist: o documento acabou antes da hora');
  }

  private expect(kind: 'open' | 'close', name: string): void {
    const token = this.next();
    if (token.kind !== kind || token.name !== name) throw new SyntaxError(`plist: esperava <${kind === 'close' ? '/' : ''}${name}>`);
  }

  /** Texto até `</name>`; etiquetas no meio são erro. */
  private text(name: string): string {
    let text = '';
    for (;;) {
      const token = this.tokens[this.index++];
      if (token === undefined) throw new SyntaxError(`plist: <${name}> sem fechamento`);
      if (token.kind === 'text') text += token.text;
      else if (token.kind === 'close' && token.name === name) return decodeEntities(text);
      else throw new SyntaxError(`plist: etiqueta inesperada dentro de <${name}>`);
    }
  }

  document(): PlistValue {
    this.expect('open', 'plist');
    const value = this.value(this.next());
    this.expect('close', 'plist');
    if (this.tokens.slice(this.index).some((t) => t.kind !== 'text' || t.text.trim() !== '')) {
      throw new SyntaxError('plist: conteúdo depois de </plist>');
    }
    return value;
  }

  private value(token: Token): PlistValue {
    if (token.kind === 'empty') {
      switch (token.name) {
        case 'true': return true;
        case 'false': return false;
        case 'string': return '';
        case 'data': return new Uint8Array(0);
        case 'array': return [];
        case 'dict': return {};
      }
    } else if (token.kind === 'open') {
      switch (token.name) {
        case 'dict': return this.dict();
        case 'array': return this.array();
        case 'string':
        case 'date': return this.text(token.name);
        case 'integer': return parseInteger(this.text('integer').trim());
        case 'real': return parseReal(this.text('real').trim());
        case 'data': return parseData(this.text('data'));
      }
    }
    throw new SyntaxError(`plist: valor inesperado (${token.kind === 'text' ? 'texto solto' : `<${token.name}>`})`);
  }

  private dict(): PlistDict {
    const entries: [string, PlistValue][] = [];
    for (;;) {
      const token = this.next();
      if (token.kind === 'close' && token.name === 'dict') return Object.fromEntries(entries);
      if (token.kind === 'empty' && token.name === 'key') {
        entries.push(['', this.value(this.next())]);
        continue;
      }
      if (token.kind !== 'open' || token.name !== 'key') throw new SyntaxError('plist: <dict> espera <key>');
      const key = this.text('key');
      const valueToken = this.next();
      if (valueToken.kind === 'close') throw new SyntaxError(`plist: a chave "${key}" ficou sem valor`);
      entries.push([key, this.value(valueToken)]);
    }
  }

  private array(): PlistValue[] {
    const items: PlistValue[] = [];
    for (;;) {
      const token = this.next();
      if (token.kind === 'close' && token.name === 'array') return items;
      items.push(this.value(token));
    }
  }
}

function parseInteger(text: string): number | bigint {
  if (!/^[+-]?\d+$/.test(text)) throw new SyntaxError(`plist: inteiro inválido "${text}"`);
  const big = BigInt(text);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

function parseReal(text: string): number {
  const value = Number(text);
  if (text === '' || Number.isNaN(value)) throw new SyntaxError(`plist: real inválido "${text}"`);
  return value;
}

function parseData(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) throw new SyntaxError('plist: <data> não é base64');
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

/**
 * Lê um documento plist XML. Dicionários são montados por `Object.fromEntries`, então uma chave
 * `"__proto__"` vira propriedade comum e não troca o protótipo. Lança `SyntaxError` fora do subconjunto.
 */
export function decodePlist(xml: string): PlistValue {
  return new Parser(tokenize(xml)).document();
}

export function isPlistDict(value: PlistValue | undefined): value is PlistDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}
