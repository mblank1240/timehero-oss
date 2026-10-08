import { describe, expect, it } from 'vitest'

import { adjustmentInput } from '@/lib/ledger/schema'

const valid = {
  employeeId: 'emp_1',
  leaveTypeId: 'type_1',
  effectiveDate: '2026-06-29',
  minutes: '480',
  reason: 'Opening balance imported from the spreadsheet',
}

function parse(overrides: Partial<Record<keyof typeof valid, string>> = {}) {
  return adjustmentInput.safeParse({ ...valid, ...overrides })
}

describe('adjustmentInput', () => {
  it('accepts a well-formed adjustment', () => {
    const result = parse()
    expect(result.success).toBe(true)
    expect(result.data?.minutes).toBe(480)
    expect(result.data?.effectiveDate.toISOString()).toBe('2026-06-29T00:00:00.000Z')
  })

  it('accepts a negative adjustment', () => {
    expect(parse({ minutes: '-240' }).data?.minutes).toBe(-240)
  })

  /**
   * The increment rule constrains what an employee may *request*. A correction
   * has to be able to say 137 minutes, because that is what the old system
   * said someone had.
   */
  it('accepts an amount that is not a multiple of any increment', () => {
    expect(parse({ minutes: '137' }).data?.minutes).toBe(137)
  })

  it('rejects zero, which would change nothing', () => {
    expect(parse({ minutes: '0' }).success).toBe(false)
  })

  it('rejects a fraction of a minute', () => {
    expect(parse({ minutes: '12.5' }).success).toBe(false)
  })

  it('rejects an implausibly large amount', () => {
    expect(parse({ minutes: String(60 * 24 * 400) }).success).toBe(false)
  })

  /** An adjustment with no reason is unexplainable once its author forgets. */
  it('rejects a missing or token reason', () => {
    expect(parse({ reason: '' }).success).toBe(false)
    expect(parse({ reason: '   ' }).success).toBe(false)
    expect(parse({ reason: 'fix' }).success).toBe(false)
  })

  it('trims the reason', () => {
    expect(parse({ reason: '  Imported opening balance  ' }).data?.reason).toBe(
      'Imported opening balance',
    )
  })

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(parse({ effectiveDate: '29/06/2026' }).success).toBe(false)
  })

  it('reports errors per field, so the form can place them', () => {
    const result = parse({ minutes: '0', reason: '' })
    const fields = result.error?.flatten().fieldErrors ?? {}
    expect(Object.keys(fields).sort()).toEqual(['minutes', 'reason'])
  })
})
