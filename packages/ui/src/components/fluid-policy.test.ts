import { createHash } from 'node:crypto';
import manifest from '../../ff-manifest.json';
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

function incompatibleSources(provider: string, inputs: { path: string; source: string }[]) {
  // Recorded policy permits motion.* under non-strict LazyMotion.
  return usesStrict(provider) ? inputs.filter(({ source }) => usesFullMotion(source)).map(({ path }) => path) : [];
}

describe('Fluid Functionalism registry drift', () => {
  // Sanctioned refresh: legitimate upstream release → re-install the item via shadcn,
  // regenerate the manifest hash, note the registry version/date. Keep registry bytes pristine.
  // CI uses the committed hash; upgrade.mjs remains the on-demand live registry check.
  it.each(manifest.files)('$path matches its committed registry SHA-256', ({ path, sha256 }) => {
    const bytes = readFileSync(new URL(`../../${path}`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex'), `${path}: registry drift`).toBe(sha256);
  });
});

describe('Fluid Functionalism LazyMotion policy', () => {
  it('strict LazyMotion provider ⇒ no motion.* in UI sources', () => {
    const provider = readFileSync(join(root, 'motion-provider.tsx'), 'utf8');
    const inputs = sources(root).map((path) => ({
      path: relative(root, path),
      source: readFileSync(path, 'utf8'),
    }));
    expect(incompatibleSources(provider, inputs), 'motion.* is legal only with a non-strict provider').toEqual([]);
  });

  it.each([
    ['motion', 'import { motion } from "motion/react"; const C = () => <motion.div />'],
    ['aliased motion', 'import { motion as animate } from "motion/react"; const C = () => <animate.div />'],
  ])('reports synthetic %s usage with a synthetic strict provider', (_name, source) => {
    const inputs = [{ path: 'inline-fixture.tsx', source }];
    expect(incompatibleSources('<LazyMotion strict features={load} />', inputs)).toEqual(['inline-fixture.tsx']);
    expect(incompatibleSources('<LazyMotion features={load} />', inputs)).toEqual([]);
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
