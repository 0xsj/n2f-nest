import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

type ViolationKind = 'catch' | 'throw';

type Violation = {
  readonly file: string;
  readonly line: number;
  readonly kind: ViolationKind;
  readonly source: string;
};

const projectRoot = resolve(import.meta.dir, '..');
const coreRoots = [
  join(projectRoot, 'src', 'modules'),
  join(projectRoot, 'src', 'workflows'),
];

function isSourceFile(file: string): boolean {
  return (
    file.endsWith('.ts') &&
    !file.endsWith('.d.ts') &&
    !file.endsWith('.spec.ts') &&
    !file.endsWith('.test.ts')
  );
}

function collectFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
      continue;
    }

    if (entry.isFile() && isSourceFile(path)) {
      files.push(path);
    }
  }

  return files;
}

function coreLayerDirectories(): string[] {
  const directories: string[] = [];

  for (const root of coreRoots) {
    if (!existsSync(root)) {
      continue;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      for (const layer of ['domain', 'app']) {
        const directory = join(root, entry.name, layer);

        if (existsSync(directory) && statSync(directory).isDirectory()) {
          directories.push(directory);
        }
      }
    }
  }

  return directories;
}

function sourceLine(source: string, position: number): string {
  return source.slice(position).split(/\r?\n/, 1)[0]?.trim() ?? '';
}

const files = coreLayerDirectories()
  .flatMap((directory) => collectFiles(directory))
  .sort();
const violations: Violation[] = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isCatchClause(node)) {
      const position = node.getStart(sourceFile);
      const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;

      violations.push({
        file,
        line,
        kind: 'catch',
        source: sourceLine(source, position),
      });
    }

    if (ts.isThrowStatement(node)) {
      const position = node.getStart(sourceFile);
      const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;

      violations.push({
        file,
        line,
        kind: 'throw',
        source: sourceLine(source, position),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (violations.length > 0) {
  console.error(
    `Error-boundary architecture check failed: ${violations.length} violation(s) in core layers.`,
  );

  for (const violation of violations) {
    console.error(
      `- ${relative(projectRoot, violation.file)}:${violation.line} ${violation.kind}: ${violation.source}`,
    );
  }

  process.exitCode = 1;
} else {
  console.log(
    `Error-boundary architecture check passed: ${files.length} core files contain no throw statements or catch clauses.`,
  );
}
