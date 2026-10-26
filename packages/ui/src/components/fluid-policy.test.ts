import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

function parse(source: string) {
  return ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function usesStrict(provider: string) {
  let strict = false;
  walk(parse(provider), (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    if (node.tagName.getText() !== 'LazyMotion') return;
    strict = node.attributes.properties.some(
      (prop) =>
        ts.isJsxAttribute(prop) &&
        prop.name.getText() === 'strict' &&
        (!prop.initializer || prop.initializer.getText() !== '{false}')
    );
  });
  return strict;
}

function usesFullMotion(source: string) {
  const ast = parse(source);
  const names = new Set<string>();
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.getText().slice(1, -1) !== 'motion/react') continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'motion') names.add(binding.name.text);
      }
    }
  }
  let found = false;
  walk(ast, (node) => {
    if (ts.isPropertyAccessExpression(node) && names.has(node.expression.getText())) found = true;
  });
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[jt]sx?$/.test(path) && !/\.test\./.test(path) ? [path] : [];
  });
}

describe('Fluid Functionalism LazyMotion policy', () => {
  it('rejects full motion/react usage under strict across all UI sources (including registry installs)', () => {
    const provider = readFileSync(join(root, 'motion-provider.tsx'), 'utf8');
    const incompatible = sources(root)
      .filter((path) => usesFullMotion(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path));
    expect(usesStrict(provider) ? incompatible : [], 'motion.* requires a non-strict LazyMotion provider').toEqual([]);
  });

  it('recognizes strict variants and imported motion aliases without matching comments or unrelated objects', () => {
    expect(usesStrict('<LazyMotion strict features={load} />')).toBe(true);
    expect(usesStrict('<LazyMotion features={load} strict={true} />')).toBe(true);
    expect(usesStrict('<LazyMotion strict={false} />')).toBe(false);
    expect(usesStrict('<LazyMotion features={load} />')).toBe(false);
    expect(usesFullMotion('import { motion } from "motion/react"; const C = () => <motion.div />')).toBe(true);
    expect(usesFullMotion('import { motion as animate } from "motion/react"; animate.div')).toBe(true);
    expect(usesFullMotion('// motion.div\nconst motion = { div: 1 }; motion.div')).toBe(false);
    expect(usesFullMotion('import { m } from "motion/react"; const C = () => <m.div />')).toBe(false);
  });
});
