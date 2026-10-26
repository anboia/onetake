// Public entrypoints must work from a fresh checkout without a device or machine configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { checkDocs, checkMarkdownLinks } from '../tools/check-docs.ts';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('documentation checks flag broken local links and ignore URLs and code examples', () => {
  const exists = (path: string): boolean => path === `${root}/README.md`;
  assert.deepEqual(checkMarkdownLinks('[Home](../README.md) [Web](https://example.com) `x[y](missing.md)`', `${root}/docs/usage.md`, root, exists), []);
  assert.deepEqual(checkMarkdownLinks('[Broken](missing.md)', `${root}/docs/usage.md`, root, exists), ['docs/usage.md: missing local link missing.md']);
  assert.deepEqual(checkMarkdownLinks('```md\n[Sample](missing.md)\n```', `${root}/docs/usage.md`, root, exists), []);
});

test('documentation checks include links in the Portuguese README', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'onetake-docs-'));
  try {
    for (const file of ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'llms.txt']) {
      writeFileSync(resolve(fixture, file), '# Documentation\n');
    }
    mkdirSync(resolve(fixture, 'docs'));
    writeFileSync(resolve(fixture, 'docs/development.md'), '# Development\n');
    for (const dir of ['.github', 'examples']) cpSync(resolve(root, dir), resolve(fixture, dir), { recursive: true });
    mkdirSync(resolve(fixture, 'config'));
    for (const file of ['package.json', '.mcp.json', 'config/defaults.json', 'config/example.json']) {
      cpSync(resolve(root, file), resolve(fixture, file));
    }
    writeFileSync(resolve(fixture, 'README.pt.md'), '[Broken](missing-translation.md)\n');
    assert.deepEqual(checkDocs(fixture).errors, ['README.pt.md: missing local link missing-translation.md']);
    writeFileSync(resolve(fixture, 'README.pt.md'), '[English](README.md)\n');
    assert.deepEqual(checkDocs(fixture).errors, []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('OneTake public CLI advertises its real commands; the legacy entrypoint stays usable', () => {
  for (const name of ['onetake', 'contrarregra']) {
    const result = spawnSync(`${root}/bin/${name}`, ['--help'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `${name}: ${result.error?.message ?? result.stderr}`);
    assert.match(result.stdout, /onetake take validate/);
    assert.match(result.stdout, /onetake runner build/);
    assert.doesNotMatch(result.stdout, /contrarregra /);
  }
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  assert.equal(pkg.name, 'onetake');
  assert.equal(pkg.private, true, 'source installation only; no accidental npm publication');
});
