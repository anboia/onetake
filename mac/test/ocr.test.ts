// Testes da T-0.14: ajudante de OCR do Mac (architecture.md A1, A2 `media`; a forma da checagem de
// AC-13.7). A imagem de teste é gerada pelo `--render-text` num diretório temporário e apagada no
// fim — nunca no repositório (HC-7, P-3). Só biblioteca padrão do Node 22; o ajudante roda com
// `xcrun swift`, que compila o script a cada chamada: com o cache de módulos frio e a CPU disputada
// pela suíte em paralelo a primeira pode passar de 60 s, por isso toda chamada usa o prazo
// `BASE_TIMEOUT_MS`.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { DEFAULTS_PATH } from '../src/core/config.ts';
import {
  BASE_TIMEOUT_MS,
  findText,
  MAX_FONT_SIZE,
  OCR_TOOL_PATH,
  ocrImages,
  renderText,
  XCRUN_PATH,
  type OcrBox,
  type OcrImage,
  type Rect,
  type RenderedText,
} from '../src/media/ocr.ts';

const TMP_ROOT = realpathSync(tmpdir());
const dir = realpathSync(mkdtempSync(join(TMP_ROOT, 'contrarregra-ocr-test-')));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function only(boxes: OcrBox[], text: string): OcrBox {
  const found = findText(boxes, text);
  assert.equal(found.length, 1, `esperava 1 caixa com ${JSON.stringify(text)}; caixas: ${JSON.stringify(boxes)}`);
  return found[0]!;
}

describe('ajudante de OCR do Mac (T-0.14; A1, A2 `media`)', () => {
  let rendered: RenderedText;
  let image: OcrImage;

  before(async () => {
    rendered = await renderText('Hagah Bible\nPsalm 23', join(dir, 'home.png'));
    const images = await ocrImages([rendered.path]);
    assert.equal(images.length, 1);
    image = images[0]!;
  });

  test('--render-text grava o PNG só no diretório temporário, com o tamanho e as linhas que informa', () => {
    assert.ok(OCR_TOOL_PATH.endsWith(join('mac', 'tools', 'ocr.swift')), OCR_TOOL_PATH);
    assert.ok(existsSync(OCR_TOOL_PATH));
    assert.equal(rendered.path, join(dir, 'home.png'));
    assert.ok(rendered.path.startsWith(TMP_ROOT + sep), `fora do diretório temporário: ${rendered.path}`);
    const png = readFileSync(rendered.path);
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
    assert.equal(png.readUInt32BE(16), rendered.width);
    assert.equal(png.readUInt32BE(20), rendered.height);
    assert.deepEqual(
      rendered.lines.map((line) => line.text),
      ['Hagah Bible', 'Psalm 23'],
    );
    for (const line of rendered.lines) {
      assert.ok(line.frame.x >= 0 && line.frame.y >= 0 && line.frame.w > 0 && line.frame.h > 0, JSON.stringify(line));
      assert.ok(line.frame.x + line.frame.w <= rendered.width && line.frame.y + line.frame.h <= rendered.height);
    }
  });

  test('Done T-0.14: o OCR acha "Hagah Bible" na imagem gerada pelo --render-text, no lugar em que foi desenhado', () => {
    assert.equal(image.path, rendered.path);
    assert.equal(image.width, rendered.width);
    assert.equal(image.height, rendered.height);
    const box = only(image.boxes, 'Hagah Bible');
    assert.ok(box.confidence > 0 && box.confidence <= 1, `confiança fora de (0, 1]: ${box.confidence}`);
    assert.ok(
      contains(rendered.lines[0]!.frame, center(box.frame)),
      `centro da caixa ${JSON.stringify(box.frame)} fora da linha desenhada ${JSON.stringify(rendered.lines[0]!.frame)}`,
    );
  });

  test('caixas em pixels da imagem com origem no canto superior esquerdo: a 2.ª linha fica abaixo da 1.ª', () => {
    const first = only(image.boxes, 'Hagah Bible');
    const second = only(image.boxes, 'Psalm 23');
    assert.ok(center(second.frame).y > center(first.frame).y, `${JSON.stringify(first.frame)} × ${JSON.stringify(second.frame)}`);
    assert.ok(contains(rendered.lines[1]!.frame, center(second.frame)));
  });

  test('forma de AC-13.7: nenhum nome de bundle.displayNames (config/defaults.json) é achado → 0 ocorrências', () => {
    const displayNames = JSON.parse(readFileSync(DEFAULTS_PATH, 'utf8')).bundle.displayNames as string[];
    assert.ok(displayNames.length > 0);
    for (const name of displayNames) {
      assert.deepEqual(findText(image.boxes, name), [], name);
    }
  });

  test('{words: true}: uma caixa por palavra, na ordem de leitura e dentro da linha desenhada', async () => {
    const [words] = await ocrImages([rendered.path], { words: true });
    assert.ok(words);
    const hagah = only(words.boxes, 'Hagah');
    const bible = only(words.boxes, 'Bible');
    assert.equal(hagah.text, 'Hagah');
    assert.equal(bible.text, 'Bible');
    assert.ok(hagah.frame.x + hagah.frame.w <= bible.frame.x + 1, `${JSON.stringify(hagah.frame)} × ${JSON.stringify(bible.frame)}`);
    assert.ok(contains(rendered.lines[0]!.frame, center(hagah.frame)));
    assert.ok(contains(rendered.lines[0]!.frame, center(bible.frame)));
    assert.deepEqual(findText(words.boxes, 'Hagah Bible'), [], 'em modo palavra nenhuma caixa tem as duas palavras');
  });

  test('imagem inexistente → rejeita citando o caminho; lista vazia → [] sem chamar o ajudante', async () => {
    const missing = join(dir, 'nao-existe.png');
    await assert.rejects(ocrImages([missing]), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(missing), err.message);
      return true;
    });
    assert.deepEqual(await ocrImages([]), []);
  });
});

describe(`--font-size / fontSize: finito, > 0 e ≤ ${MAX_FONT_SIZE} px; fora disso é uso errado`, () => {
  const INVALID_CLI = ['inf', 'Infinity', '-inf', 'nan', '1e20', '1e6', '513', '0', '-5', 'abc'];
  const INVALID_TS = [Infinity, -Infinity, Number.NaN, 1e20, 1e6, MAX_FONT_SIZE + 1, 0, -1];

  test('o teto é 512 px', () => {
    assert.equal(MAX_FONT_SIZE, 512);
  });

  test('ajudante: --font-size inválido sai com status 2 e a mensagem de uso, sem trap e sem gravar o PNG', () => {
    for (const raw of INVALID_CLI) {
      const out = join(dir, `font-${raw}.png`);
      const result = spawnSync(
        XCRUN_PATH,
        ['swift', OCR_TOOL_PATH, '--render-text', 'x', '--out', out, '--font-size', raw],
        { encoding: 'utf8', timeout: BASE_TIMEOUT_MS },
      );
      assert.equal(result.signal, null, `${raw}: morto por ${result.signal}`);
      assert.equal(result.status, 2, `${raw}: status ${result.status}; stderr: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`--font-size inválido: ${raw.replace(/[.+-]/g, '\\$&')}`), raw);
      assert.match(result.stderr, /uso: xcrun swift ocr\.swift/, raw);
      assert.equal(result.stdout, '', raw);
      assert.equal(existsSync(out), false, raw);
    }
  });

  test('renderText: fontSize inválido rejeita com erro claro antes de chamar o ajudante', async () => {
    const spawned: unknown[] = [];
    const onChild = (message: unknown): void => {
      spawned.push(message);
    };
    subscribe('child_process', onChild);
    try {
      for (const fontSize of INVALID_TS) {
        const out = join(dir, `ts-font-${String(fontSize)}.png`);
        await assert.rejects(renderText('x', out, { fontSize }), (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, new RegExp(`fontSize inválido: ${String(fontSize).replace(/[.+-]/g, '\\$&')}`));
          assert.match(err.message, /finito, > 0 e ≤ 512/);
          return true;
        });
        assert.equal(existsSync(out), false, String(fontSize));
      }
      assert.deepEqual(spawned, [], 'nenhum processo filho para fontSize inválido');

      // Controle positivo: o limite (512) é aceito e aí sim o ajudante roda (o canal vê o processo).
      const edge = await renderText('x', join(dir, 'font-512.png'), { fontSize: MAX_FONT_SIZE });
      assert.ok(existsSync(edge.path));
      assert.equal(edge.lines.length, 1);
      assert.ok(spawned.length > 0, 'o canal child_process deveria ver a chamada válida');
    } finally {
      unsubscribe('child_process', onChild);
    }
  });
});

describe('findText (busca de trecho nas caixas)', () => {
  const box = (text: string): OcrBox => ({ text, frame: { x: 0, y: 0, w: 1, h: 1 }, confidence: 1 });

  test('acha o trecho ignorando maiúsculas e espaços repetidos; devolve as caixas na ordem recebida', () => {
    const boxes = [box('Open  HAGAH bible'), box('Psalm 23'), box('hagah Bible')];
    assert.deepEqual(findText(boxes, 'Hagah Bible'), [boxes[0], boxes[2]]);
    assert.deepEqual(findText(boxes, '  psalm   23 '), [boxes[1]]);
    assert.deepEqual(findText(boxes, 'Contrarregra'), []);
  });

  test('trecho vazio não acha nada', () => {
    assert.deepEqual(findText([box('Hagah Bible')], '   '), []);
  });
});
