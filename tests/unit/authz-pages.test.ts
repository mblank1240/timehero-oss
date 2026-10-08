import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A layout's check is not a page's check: Next can render a page segment
 * without re-running the layout above it. So every page under a gated tree
 * calls the gate itself, and this test fails the build for one that forgets.
 */
const ROOT = join(__dirname, '..', '..')

const GATES = [
  { dir: 'app/admin', guard: 'requireAdmin' },
  { dir: 'app/reports', guard: 'requireReportsAccess' },
] as const

/** The function the first statement of the page's default export awaits, if any. */
function firstAwaited(path: string, source: string): string | null {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const page = file.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) &&
      (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
  )
  const first = page?.body?.statements[0]
  if (!first) return null
  const expression = ts.isExpressionStatement(first)
    ? first.expression
    : ts.isVariableStatement(first)
      ? first.declarationList.declarations[0]?.initializer
      : undefined
  if (!expression || !ts.isAwaitExpression(expression)) return null
  const call = expression.expression
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) ? call.expression.text : null
}

function pagesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.split(/[\\/]/).at(-1) === 'page.tsx')
    .map((path) => join(dir, path))
}

describe('gated pages check access themselves', () => {
  for (const { dir, guard } of GATES) {
    const pages = pagesUnder(dir)

    it(`finds the pages under ${dir}`, () => {
      expect(pages.length).toBeGreaterThan(0)
    })

    for (const page of pages) {
      it(`${relative('.', page)} awaits ${guard}()`, () => {
        const source = readFileSync(join(ROOT, page), 'utf8')
        expect(source).toMatch(new RegExp(`import \\{[^}]*\\b${guard}\\b[^}]*\\} from '@/lib/authz'`))

        // The gate is the first thing the page does, before it reads anything.
        expect(firstAwaited(page, source)).toBe(guard)
      })
    }
  }
})
