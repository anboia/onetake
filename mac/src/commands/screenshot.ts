// Operação `screenshot` (S8 item 3; CLI `screenshot`, MCP `screenshot`): **uma** captura
// `screen.shot {format: png, scale: native}` (S1 item 4) — o runner só captura com o app alvo ou um app
// permitido em primeiro plano (S1 item 11; senão `E_FORBIDDEN_APP` e nada é salvo). O PNG nativo vai para
// `paths.cache/explore/` (pasta 0700, arquivo 0600, fora do repositório; podado para as `EXPLORE_KEEP`
// mais recentes), e dele sai o JPEG em pontos (390×844 no iPhone 12, qualidade 0,8) pelo `/usr/bin/sips`
// (ferramenta da Apple, só converte; nada de ffmpeg). JPEG e PNG são o mesmo quadro: as coordenadas da
// imagem são os pontos do XCUITest.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { ContrarregraError } from '../core/errors.ts';
import { runnerPaths } from '../runner/paths.ts';
import type { CommandContext } from './context.ts';
import { checked, withControl } from './explore.ts';

/** Quantas capturas de exploração ficam em `paths.cache/explore/` (⚠️ 200, S8 item 3). */
export const EXPLORE_KEEP = 200;
/** Qualidade do JPEG para o Claude Code (⚠️ 0,8, S8 item 3). */
export const JPEG_QUALITY = 0.8;
/** O `sips` do sistema (nunca pelo PATH). */
export const SIPS_PATH = '/usr/bin/sips';
const SIPS_TIMEOUT_MS = 15_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `screen.shot` → `{image, format, widthPx, heightPx, scale}` (S1 item 4). */
const ScreenShotResultSchema = z.strictObject({
  image: z.string().min(1),
  format: z.literal('png'),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  scale: z.number().positive(),
});

export interface ScreenshotResult {
  /** O JPEG em pontos, em base64 (o que vai para o modelo). */
  jpeg: { base64: string; widthPx: number; heightPx: number; bytes: number; quality: number; scale: 1 };
  /** O PNG nativo salvo em `paths.cache/explore/`. */
  png: { path: string; widthPx: number; heightPx: number; scale: number };
}

/** `YYYYMMDD-HHMMSS-mmm-<hex>.png` (hora local), único e em ordem de tempo. */
function captureName(now = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  return `${date}-${time}-${randomBytes(3).toString('hex')}.png`;
}

/** Deixa só as `keep` capturas `.png` mais recentes da pasta (por data de modificação). */
export function pruneExplore(dir: string, keep = EXPLORE_KEEP): string[] {
  const shots = readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((shot) => shot !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const removed: string[] = [];
  for (const shot of shots.slice(keep)) {
    const path = join(dir, shot.name);
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}

/** `sips -s format jpeg -s formatOptions <q> -z <h> <w> <png> --out <jpg>`; saída padrão descartada (no MCP ela é o protocolo). */
function sipsToJpeg(png: string, jpg: string, width: number, height: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(Math.round(JPEG_QUALITY * 100)), '-z', String(height), String(width), png, '--out', jpg];
    const child = spawn(SIPS_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), SIPS_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`não consegui rodar ${SIPS_PATH}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${SIPS_PATH} falhou (${signal ?? `saída ${code}`}) ao gerar o JPEG: ${stderr.trim()}`));
    });
  });
}

/** `screenshot`. */
export async function screenshot(ctx: CommandContext): Promise<ScreenshotResult> {
  const shot = await withControl(ctx, async (connection) =>
    checked('screen.shot', ScreenShotResultSchema, await connection.call('screen.shot', { format: 'png', scale: 'native' })),
  );
  const png = Buffer.from(shot.image, 'base64');
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new ContrarregraError('E_RUNNER_DOWN', 'a resposta do screen.shot não segue S1: `image` não é um PNG em base64', {
      reason: 'protocol-mismatch',
      method: 'screen.shot',
      hint: 'contrarregra runner build && contrarregra runner up',
    });
  }

  const dir = join(runnerPaths(ctx.config).cache, 'explore');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const name = captureName();
  const pngPath = join(dir, name);
  writeFileSync(pngPath, png, { mode: 0o600, flag: 'wx' });
  const jpgPath = join(dir, `${name.slice(0, -'.png'.length)}.jpg`);
  const widthPt = Math.round(shot.widthPx / shot.scale);
  const heightPt = Math.round(shot.heightPx / shot.scale);
  let jpeg: Buffer;
  try {
    await sipsToJpeg(pngPath, jpgPath, widthPt, heightPt);
    jpeg = readFileSync(jpgPath);
  } finally {
    rmSync(jpgPath, { force: true });
  }
  pruneExplore(dir);
  return {
    jpeg: { base64: jpeg.toString('base64'), widthPx: widthPt, heightPx: heightPt, bytes: jpeg.length, quality: JPEG_QUALITY, scale: 1 },
    png: { path: pngPath, widthPx: shot.widthPx, heightPx: shot.heightPx, scale: shot.scale },
  };
}
