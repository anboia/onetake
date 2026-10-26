// Public entrypoints must work from a fresh checkout without a device or machine configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { checkMarkdownLinks } from '../tools/check-docs.ts';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('documentation checks flag broken local links and ignore URLs and code examples', () => {
  const exists = (path: string): boolean => path === `${root}/README.md`;
  assert.deepEqual(checkMarkdownLinks('[Home](../README.md) [Web](https://example.com) `x[y](missing.md)`', `${root}/docs/usage.md`, root, exists), []);
  assert.deepEqual(checkMarkdownLinks('[Broken](missing.md)', `${root}/docs/usage.md`, root, exists), ['docs/usage.md: missing local link missing.md']);
  assert.deepEqual(checkMarkdownLinks('```md\n[Sample](missing.md)\n```', `${root}/docs/usage.md`, root, exists), []);
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
