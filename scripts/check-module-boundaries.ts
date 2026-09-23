import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

/**
 * Enforces the module-boundary rules in notes/architecture/hardening-bar.md
 * (Boundaries, B1 and B5). Every relative import in src/ is classified by the
 * area of the importing file and the area of its target:
 *
 * - modules/X     → modules/X, shared, platform (specs may also use test/support)
 * - shared        → shared (specs may also use platform test tooling)
 * - platform      → shared, platform
 * - integration   → integration, shared, platform, modules/Y/api.ts
 * - workflows/W   → workflows/W, shared, platform, modules/Y/{api,commands}.ts
 * - composition   → anything except module internals and modules/Y/commands.ts
 *   (main.ts, app.module.ts, app/)
 *
 * A module's api.ts is its public surface; commands.ts carries the commands
 * other modules may never call, so only workflows may import it.
 */

type Area =
  | { kind: 'module'; name: string }
  | { kind: 'workflow'; name: string }
  | { kind: 'shared' | 'platform' | 'integration' | 'composition' | 'test-support' }
  | { kind: 'outside' };

type Violation = { file: string; line: number; target: string; reason: string };

const projectRoot = resolve(import.meta.dir, '..');
const srcRoot = join(projectRoot, 'src');

function collect(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.isFile() && path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

function areaOf(file: string): Area {
  const fromSrc = relative(srcRoot, file).split(sep);
  if (fromSrc[0] === '..') {
    return relative(projectRoot, file).startsWith(join('test', 'support'))
      ? { kind: 'test-support' }
      : { kind: 'outside' };
  }
  switch (fromSrc[0]) {
    case 'modules':
      return { kind: 'module', name: fromSrc[1] ?? '' };
    case 'workflows':
      return { kind: 'workflow', name: fromSrc[1] ?? '' };
    case 'shared':
    case 'platform':
    case 'integration':
      return { kind: fromSrc[0] };
    default:
      return { kind: 'composition' };
  }
}

/** The public entry a target file is, if any: `api` or `commands` at a module root. */
function entryOf(target: string): 'api' | 'commands' | undefined {
  const fromSrc = relative(srcRoot, target).split(sep);
  if (fromSrc[0] !== 'modules' || fromSrc.length !== 3) return undefined;
  if (fromSrc[2] === 'api.ts') return 'api';
  if (fromSrc[2] === 'commands.ts') return 'commands';
  return undefined;
}

function resolveTarget(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return base.replace(/\.js$/, '.ts');
}

function check(file: string, target: string): string | undefined {
  const from = areaOf(file);
  const to = areaOf(target);
  const isSpec = file.endsWith('.spec.ts');
  if (to.kind === 'outside') return undefined;

  switch (from.kind) {
    case 'module':
      if (to.kind === 'module' && to.name === from.name) return undefined;
      if (to.kind === 'shared' || to.kind === 'platform') return undefined;
      if (to.kind === 'test-support' && isSpec) return undefined;
      // The composition root's migration list is shared test infrastructure.
      if (isSpec && to.kind === 'composition') return undefined;
      return `module ${from.name} may import only itself, shared/ and platform/`;
    case 'shared':
      if (to.kind === 'shared') return undefined;
      // Specs may drive shared leaves with platform test tooling (chaos harness).
      if (isSpec && (to.kind === 'platform' || to.kind === 'test-support')) return undefined;
      return 'shared/ may import only shared/';
    case 'platform':
      return to.kind === 'shared' || to.kind === 'platform'
        ? undefined
        : 'platform/ may import only shared/ and platform/';
    case 'integration':
      if (['integration', 'shared', 'platform'].includes(to.kind)) return undefined;
      if (to.kind === 'module' && entryOf(target) === 'api') return undefined;
      return to.kind === 'module' && entryOf(target) === 'commands'
        ? 'bridges may call queries only; commands cross modules only from workflows'
        : "integration/ may import a module only through its api.ts";
    case 'workflow':
      if (to.kind === 'workflow' && to.name === from.name) return undefined;
      if (to.kind === 'shared' || to.kind === 'platform') return undefined;
      if (to.kind === 'module' && entryOf(target) !== undefined) return undefined;
      if (to.kind === 'test-support' && isSpec) return undefined;
      return 'a workflow may import a module only through its api.ts or commands.ts';
    case 'composition':
      if (to.kind === 'module') {
        return entryOf(target) === 'api'
          ? undefined
          : 'the composition root may import a module only through its api.ts';
      }
      return undefined;
    default:
      return undefined;
  }
}

function specifiers(file: string): Array<{ specifier: string; line: number }> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: Array<{ specifier: string; line: number }> = [];
  const add = (node: ts.Node, literal: ts.Expression | undefined) => {
    if (literal && ts.isStringLiteral(literal) && literal.text.startsWith('.')) {
      found.push({
        specifier: literal.text,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node, node.argument.literal as ts.Expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const violations: Violation[] = [];
const files = collect(srcRoot);
for (const file of files) {
  for (const { specifier, line } of specifiers(file)) {
    const target = resolveTarget(file, specifier);
    const reason = check(file, target);
    if (reason) {
      violations.push({
        file: relative(projectRoot, file),
        line,
        target: relative(projectRoot, target),
        reason,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`Module-boundary check found ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line} imports ${violation.target}\n    ${violation.reason}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`Module-boundary check passed: ${files.length} files respect the module boundaries.`);
}
