/**
 * Writing CSV. Phase 8 puts an export on every report; this is the one place
 * that knows the quoting rules.
 */

export type CsvCell = string | number | null | undefined

/**
 * One field, quoted when it has to be. A field beginning with `=`, `+`, `-`
 * or `@` is prefixed with an apostrophe so a spreadsheet does not run it as a
 * formula — a note an employee typed is otherwise a way into whoever opens
 * the export. Numbers are written as they are: a negative figure is data.
 */
export function csvField(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

/** Rows to a CSV document with CRLF line endings, as RFC 4180 has it. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/**
 * Reading CSV, for the one-time import. RFC 4180: quoted fields may hold
 * commas, doubled quotes and line breaks. A byte-order mark — which Excel
 * writes on "CSV UTF-8" — is dropped, and blank lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const input = text.replace(/^﻿/, '')

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      if (row.some((cell) => cell.trim() !== '')) rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (quoted) throw new Error('The file ends inside a quoted field.')
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) rows.push(row)
  return rows
}

/**
 * The same, keyed by the header row. Headers are matched case-insensitively
 * with spaces and dashes read as underscores, so "Hire Date" is `hire_date`.
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(text)
  if (!header) return []
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'))
  return body.map((cells) =>
    Object.fromEntries(keys.map((key, i) => [key, (cells[i] ?? '').trim()])),
  )
}
