// JCS — JSON Canonicalization Scheme (RFC 8785), escrito à mão (sem dependência). Usado no
// `compiled.sha256` da coreografia (S0.4) e na comparação byte a byte das fixtures com o Swift (AC-0.6).
//
// Regras da RFC: sem espaços; chaves dos objetos ordenadas pelas unidades de código UTF-16 (é o que o
// `sort()` padrão do JavaScript faz); strings serializadas como no `JSON.stringify` do ECMAScript
// (escapa só `"`, `\` e os controles < U+0020, com `\b \t \n \f \r` curtos e o resto como `\u00xx`
// minúsculo); números pelo algoritmo do `Number.prototype.toString` (o mesmo do ECMAScript que a RFC
// adota), com -0 → `0`; NaN e ±Infinity não são JSON. A entrada tem de ser I-JSON: string com surrogate
// isolado é recusada. Propriedades `undefined` de objetos são omitidas (como no `JSON.stringify`).

import { createHash } from 'node:crypto';

/** Serialização canônica (RFC 8785) de um valor JSON. Lança `TypeError` para o que não é I-JSON. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`JCS: número não finito (${String(value)}) não é JSON`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return serializeString(value);
    case 'object':
      break;
    default:
      throw new TypeError(`JCS: valor do tipo ${typeof value} não é JSON`);
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (item === undefined) throw new TypeError(`JCS: posição ${i} da lista sem valor JSON`);
      parts.push(canonicalize(item));
    }
    return `[${parts.join(',')}]`;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'desconhecido';
    throw new TypeError(`JCS: objeto ${name} não é um objeto JSON simples`);
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(`${serializeString(key)}:${canonicalize(item)}`);
  }
  return `{${parts.join(',')}}`;
}

function serializeString(text: string): string {
  if (!text.isWellFormed()) throw new TypeError('JCS: string com surrogate UTF-16 isolado não é I-JSON (RFC 8785 §3.2.2.2)');
  return JSON.stringify(text);
}

/** SHA-256 (hex minúsculo) dos bytes UTF-8 da serialização JCS. */
export function jcsSha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
