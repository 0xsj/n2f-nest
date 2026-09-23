import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

type ViolationKind = 'catch' | 'throw' | 'promise-reject' | 'promise-catch' | 'promise-executor';

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

    // Rejected promises are exceptions by another name: they bypass the
    // Result contract exactly as `throw` does.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (method === 'reject' && ts.isIdentifier(receiver) && receiver.text === 'Promise') {
        record(node, 'promise-reject');
      } else if (method === 'catch') {
        record(node, 'promise-catch');
      }
    }

    // A hand-built promise can reject from its executor.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Promise'
    ) {
      record(node, 'promise-executor');
    }

    ts.forEachChild(node, visit);
  }

  function record(node: ts.Node, kind: ViolationKind): void {
    const position = node.getStart(sourceFile);
    violations.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(position).line + 1,
      kind,
      source: sourceLine(source, position),
    });
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
    `Error-boundary architecture check passed: ${files.length} core files contain no throw, catch or promise rejection.`,
  );
}
