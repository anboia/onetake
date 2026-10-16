// Leitor de PNG mínimo para a conferência da fonte viva (S9 item 3: "GetSourceScreenshot não pode ser
// preta"), copiado do SP-5 (`spikes/sp-5/lib.ts`; o produto não importa `spikes/`): 8 bits, sem
// entrelaçamento, tudo na memória (nada vai para o disco).

import { inflateSync } from 'node:zlib';

export interface RgbImage {
  width: number;
  height: number;
  /** 1 (cinza), 2 (cinza + alfa), 3 (RGB) ou 4 (RGBA). */
  channels: number;
  /** Por linhas, `width × height × channels` bytes. */
  data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** PNG de 8 bits (tipos 0, 2, 4, 6), sem entrelaçamento; o resto é recusado com erro. */
export function decodePng(input: Uint8Array): RgbImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG: assinatura inválida');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9] ?? -1;
      const interlace = body[12];
      if (depth !== 8) throw new Error(`PNG: profundidade ${depth} não suportada (só 8 bits)`);
      if (interlace !== 0) throw new Error('PNG: entrelaçado não suportado');
      const c = PNG_CHANNELS[colorType];
      if (c === undefined) throw new Error(`PNG: tipo de cor ${colorType} não suportado`);
      channels = c;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (width === 0 || height === 0 || channels === 0) throw new Error('PNG: sem IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error(`PNG: dados curtos (${raw.length} < ${height * (stride + 1)})`);
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? out[dst + x - channels]! : 0;
      const b = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels]! : 0;
      let r: number;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`PNG: filtro ${String(filter)} inválido na linha ${y}`);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** `data:image/png;base64,…` (GetSourceScreenshot) ou base64 puro → bytes. */
export function base64Image(text: string): Buffer {
  const comma = text.startsWith('data:') ? text.indexOf(',') : -1;
  return Buffer.from(comma >= 0 ? text.slice(comma + 1) : text, 'base64');
}

/** Não preta: ao menos 1 % dos pixels com luma > 16 (S9 item 3). */
export function nonBlack(img: RgbImage): boolean {
  const c = img.channels;
  const total = img.width * img.height;
  let bright = 0;
  for (let i = 0; i < total; i++) {
    const p = i * c;
    const luma = c >= 3 ? (img.data[p]! + img.data[p + 1]! + img.data[p + 2]!) / 3 : img.data[p]!;
    if (luma > 16) bright++;
  }
  return total > 0 && bright / total >= 0.01;
}
