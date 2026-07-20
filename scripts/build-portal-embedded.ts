#!/usr/bin/env bun
/** Generates src/portal-embedded.ts from portal/dist for compiled installs. */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const REPO = join(import.meta.dir, '..');
const DIST = join(REPO, 'portal', 'dist');
const OUT = join(REPO, 'src', 'portal-embedded.ts');

function walk(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? 'application/octet-stream' : mime[filename.slice(dot).toLowerCase()] || 'application/octet-stream';
}

const files = walk(DIST);
if (!files.length) {
  console.error('[build-portal-embedded] no files under portal/dist — run `cd portal && bun run build` first.');
  process.exit(1);
}

const imports: string[] = [];
const entries: string[] = [];
for (let index = 0; index < files.length; index += 1) {
  const rel = files[index];
  const ident = `P_${index}_${rel.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '')}`;
  const importPath = `../portal/dist/${rel.split(/[\\/]/).join('/')}`;
  imports.push('// @ts-ignore — type: file is Bun ESM syntax');
  imports.push(`import ${ident} from '${importPath}' with { type: 'file' };`);
  entries.push(`  ${JSON.stringify(`/portal/${rel.split(/[\\/]/).join('/')}`)}: { path: ${ident} as unknown as string, mime: ${JSON.stringify(mimeFor(rel))} },`);
}

const content = `// AUTO-GENERATED — do not edit by hand.\n// Run \`bun run scripts/build-portal-embedded.ts\` to regenerate.\n// Source: portal/dist (deterministic; no generation timestamp).\n\n${imports.join('\n')}\n\nexport interface PortalAsset { path: string; mime: string; }\nexport const PORTAL_ASSETS: Record<string, PortalAsset> = {\n${entries.join('\n')}\n};\nexport const PORTAL_INDEX_HTML = PORTAL_ASSETS['/portal/index.html'];\nexport const PORTAL_ASSET_COUNT = ${files.length};\n`;

const existing = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
if (existing === content) console.log(`[build-portal-embedded] up to date (${files.length} files)`);
else {
  writeFileSync(OUT, content, 'utf8');
  console.log(`[build-portal-embedded] wrote ${OUT} (${files.length} files)`);
}
