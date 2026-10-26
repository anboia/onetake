// Public documentation checks: local links, generic choreography and parseable configuration.
// No phone, OBS, Keychain or network access. Historical spec/spike notes are deliberately excluded.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { validateTakeFile } from '../src/take/choreo.ts';

export function checkMarkdownLinks(text: string, file: string, root: string, exists: (path: string) => boolean = existsSync): string[] {
  const prose = text.replace(/```[^]*?```/g, '').replace(/`[^`]*`/g, '');
  const errors: string[] = [];
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1]!;
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link)) continue;
    const path = decodeURIComponent(link.split('#')[0]!.split('?')[0]!);
    if (!path) continue;
    const target = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(file), path);
    if (!exists(target)) errors.push(`${relative(root, file)}: missing local link ${link}`);
  }
  return errors;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

export function checkDocs(root: string): { files: number; errors: string[] } {
  const files = ['README.md', 'README.en.md', 'README.pt.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'llms.txt']
    .map((file) => join(root, file));
  files.push(...markdownFiles(join(root, 'docs')), ...markdownFiles(join(root, '.github')));
  const errors = files.flatMap((file) => checkMarkdownLinks(readFileSync(file, 'utf8'), file, root));
  const example = validateTakeFile(join(root, 'examples/first-take.choreo.yaml'));
  errors.push(...example.errors.map((error) => `example ${error.path}: ${error.message}`));
  for (const file of ['package.json', '.mcp.json', 'config/defaults.json', 'config/example.json']) {
    try { JSON.parse(readFileSync(join(root, file), 'utf8')); }
    catch (error) { errors.push(`${file}: ${String(error)}`); }
  }
  for (const file of ['.github/workflows/ci.yml', '.github/dependabot.yml', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml']) {
    try { parseYaml(readFileSync(join(root, file), 'utf8'), { uniqueKeys: true }); }
    catch (error) { errors.push(`${file}: ${String(error)}`); }
  }
  return { files: files.length, errors };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const result = checkDocs(root);
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Documentation OK: ${result.files} public documents, local file links, example choreography and JSON/YAML configuration.\n`);
  }
}
