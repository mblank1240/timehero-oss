import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { ADMIN_SECTIONS, REPORT_SECTIONS } from '@/lib/permissions'

/**
 * A layout's check is not a page's check: Next can render a page segment
 * without re-running the layout above it. So every page under a gated tree
 * calls the gate itself, and this test fails the build for one that forgets.
 * It also holds each page to the permission its section is listed under, so
 * the navigation and the gate cannot drift apart.
 */
const ROOT = join(__dirname, '..', '..')

const GATES = [
  { dir: 'app/admin', sections: ADMIN_SECTIONS },
  { dir: 'app/reports', sections: REPORT_SECTIONS },
] as const

/** Pages gated differently from their section, and why. */
const EXCEPTIONS: Record<string, { guard: string; permission?: string }> = {
  // Recording leave for someone is acting on their time records.
  'app/admin/employees/[id]/leave/page.tsx': {
    guard: 'requirePermission',
    permission: 'MANAGE_TIME_RECORDS',
  },
  // Reads nothing: it sends each person to the first report they may read.
  'app/reports/page.tsx': { guard: 'requireUser' },
}

/**
 * The function the first statement of the page's default export awaits, and
 * its first argument when that is a string literal.
 */
function firstAwaited(path: string, source: string): { guard: string; argument?: string } | null {
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
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null
  const [arg] = call.arguments
  return {
    guard: call.expression.text,
    ...(arg && ts.isStringLiteral(arg) ? { argument: arg.text } : {}),
  }
}

function pagesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.split(/[\\/]/).at(-1) === 'page.tsx')
    .map((path) => join(dir, path))
}

describe('gated pages check access themselves', () => {
  for (const { dir, sections } of GATES) {
    const pages = pagesUnder(dir)

    it(`finds the pages under ${dir}`, () => {
      expect(pages.length).toBeGreaterThan(0)
    })

    for (const page of pages) {
      const path = relative('.', page).split('\\').join('/')
      const section = sections.find((s) => path.startsWith(`app${s.href}/`))
      const expected = EXCEPTIONS[path] ?? {
        guard: 'requirePermission',
        permission: section?.permission,
      }

      it(`${path} awaits ${expected.guard}(${expected.permission ?? ''})`, () => {
        const source = readFileSync(join(ROOT, page), 'utf8')
        expect(source).toMatch(
          new RegExp(`import \\{[^}]*\\b${expected.guard}\\b[^}]*\\} from '@/lib/authz'`),
        )

        // The gate is the first thing the page does, before it reads anything,
        // and asks for the permission its section is listed under.
        expect(firstAwaited(page, source)).toEqual({
          guard: expected.guard,
          ...(expected.permission ? { argument: expected.permission } : {}),
        })
      })
    }
  }
})
