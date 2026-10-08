import { describe, expect, it } from 'vitest'

import { leaveRequestInput, requestFormValues } from '@/lib/requests/schema'

const halfDays = leaveRequestInput({
  incrementMinutes: 240,
  allowSubIncrementWhenBalanceIsLower: true,
})
const fullDays = leaveRequestInput({
  incrementMinutes: 480,
  allowSubIncrementWhenBalanceIsLower: true,
})

function values(days: Record<string, string>) {
  return {
    leaveTypeId: 'pto',
    days: Object.entries(days).map(([date, minutes]) => ({ date, minutes })),
  }
}

describe('leaveRequestInput', () => {
  it('drops days set to none', () => {
    const parsed = halfDays.parse(values({ '2026-10-12': '480', '2026-10-13': '0' }))
    expect(parsed.days).toEqual([{ date: '2026-10-12', minutes: 480 }])
  })

  it('needs at least one day', () => {
    expect(halfDays.safeParse(values({ '2026-10-12': '0' })).success).toBe(false)
  })

  it('refuses a date that does not exist', () => {
    expect(halfDays.safeParse(values({ '2026-02-30': '480' })).success).toBe(false)
  })

  it('reads the increment it was built with', () => {
    expect(halfDays.safeParse(values({ '2026-10-12': '240' })).success).toBe(true)
    expect(fullDays.safeParse(values({ '2026-10-12': '240', '2026-10-13': '480' })).success).toBe(
      false,
    )
  })

  it('keys an increment error to the day', () => {
    const result = halfDays.safeParse(values({ '2026-10-12': '480', '2026-10-13': '300' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toEqual(['day.2026-10-13'])
  })

  it('lets one sub-increment day through for the service to judge', () => {
    expect(halfDays.safeParse(values({ '2026-10-12': '180' })).success).toBe(true)
    expect(
      leaveRequestInput({
        incrementMinutes: 240,
        allowSubIncrementWhenBalanceIsLower: false,
      }).safeParse(values({ '2026-10-12': '180' })).success,
    ).toBe(false)
  })

  it('does not let a sub-increment day through alongside others', () => {
    expect(halfDays.safeParse(values({ '2026-10-12': '180', '2026-10-13': '480' })).success).toBe(
      false,
    )
  })
})

describe('requestFormValues', () => {
  it('folds one field per day into a list', () => {
    const form = new FormData()
    form.set('leaveTypeId', 'pto')
    form.set('day.2026-10-12', '480')
    form.set('day.2026-10-13', '240')
    form.set('note', 'Family wedding')

    expect(requestFormValues(form)).toEqual({
      leaveTypeId: 'pto',
      note: 'Family wedding',
      days: [
        { date: '2026-10-12', minutes: '480' },
        { date: '2026-10-13', minutes: '240' },
      ],
    })
  })
})
