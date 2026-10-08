import { describe, expect, it } from 'vitest'

import { NOTIFICATION_TYPES, channelsFor } from '@/lib/notifications/channels'
import {
  hourIn,
  reminderSlot,
  timesheetReminder,
  waitingSince,
} from '@/lib/notifications/schedule'
import { notificationSettingsInput, preferencesInput } from '@/lib/notifications/schema'

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const at = (iso: string) => new Date(iso)

describe('channelsFor', () => {
  const base = {
    type: 'REQUEST_DECIDED' as const,
    enabledTypes: [...NOTIFICATION_TYPES],
    emailAvailable: true,
    pushAvailable: true,
    preference: undefined,
    approvalDigest: false,
  }

  it('creates nothing at all for a type the organization switched off', () => {
    expect(channelsFor({ ...base, enabledTypes: ['APPROVAL_WAITING'] })).toBeNull()
  })

  it('defaults to push and email', () => {
    expect(channelsFor(base)).toEqual({ push: true, email: 'SEND' })
  })

  it('sends no email when the organization has no sending address, whatever the person chose', () => {
    expect(channelsFor({ ...base, emailAvailable: false })).toEqual({ push: true, email: null })
  })

  it('sends no push to someone with no browser subscribed', () => {
    expect(channelsFor({ ...base, pushAvailable: false })).toEqual({ push: false, email: 'SEND' })
  })

  it('follows the person’s choice per type', () => {
    expect(channelsFor({ ...base, preference: { push: false, email: true } })).toEqual({
      push: false,
      email: 'SEND',
    })
    expect(channelsFor({ ...base, preference: { push: true, email: false } })).toEqual({
      push: true,
      email: null,
    })
  })

  it('holds approval email for a digest, and only approval email', () => {
    expect(
      channelsFor({ ...base, type: 'APPROVAL_WAITING', approvalDigest: true }),
    ).toEqual({ push: true, email: 'DIGEST' })
    expect(channelsFor({ ...base, approvalDigest: true })).toEqual({ push: true, email: 'SEND' })
  })

  it('a digest does not bring back email the person turned off', () => {
    expect(
      channelsFor({
        ...base,
        type: 'APPROVAL_WAITING',
        approvalDigest: true,
        preference: { push: true, email: false },
      }),
    ).toEqual({ push: true, email: null })
  })
})

describe('reminderSlot — the church’s 7 days, daily, then 3 more days, every 4 hours', () => {
  const church = {
    approvalReminderAfterDays: 7,
    approvalReminderIntervalHours: 24,
    approvalEscalateAfterDays: 3,
    approvalEscalateIntervalHours: 4,
  }
  const since = at('2026-10-01T15:00:00Z')

  it('stays quiet for the first seven days', () => {
    expect(reminderSlot(since, at('2026-10-01T15:00:00Z'), church)).toBeNull()
    expect(reminderSlot(since, at('2026-10-08T14:59:59Z'), church)).toBeNull()
  })

  it('reminds once a day from day seven', () => {
    expect(reminderSlot(since, at('2026-10-08T15:00:00Z'), church)).toEqual({
      key: 'daily-0',
      escalated: false,
    })
    // Every hourly sweep that day names the same slot, so it is sent once.
    expect(reminderSlot(since, at('2026-10-09T14:00:00Z'), church)?.key).toBe('daily-0')
    expect(reminderSlot(since, at('2026-10-09T15:00:00Z'), church)?.key).toBe('daily-1')
    expect(reminderSlot(since, at('2026-10-11T14:59:00Z'), church)?.key).toBe('daily-2')
  })

  it('escalates to every four hours after a further three days', () => {
    expect(reminderSlot(since, at('2026-10-11T15:00:00Z'), church)).toEqual({
      key: 'frequent-0',
      escalated: true,
    })
    expect(reminderSlot(since, at('2026-10-11T18:59:00Z'), church)?.key).toBe('frequent-0')
    expect(reminderSlot(since, at('2026-10-11T19:00:00Z'), church)?.key).toBe('frequent-1')
    expect(reminderSlot(since, at('2026-10-12T15:00:00Z'), church)?.key).toBe('frequent-6')
  })

  it('reads its numbers from the settings', () => {
    const brisk = {
      approvalReminderAfterDays: 1,
      approvalReminderIntervalHours: 12,
      approvalEscalateAfterDays: 0,
      approvalEscalateIntervalHours: 1,
    }
    expect(reminderSlot(since, at('2026-10-02T14:00:00Z'), brisk)).toBeNull()
    expect(reminderSlot(since, at('2026-10-02T15:00:00Z'), brisk)).toEqual({
      key: 'frequent-0',
      escalated: true,
    })
  })
})

describe('waitingSince', () => {
  const created = at('2026-10-01T09:00:00Z')

  it('is the submission for the first step', () => {
    expect(waitingSince({ step: 1, createdAt: created }, [])).toEqual(created)
  })

  it('is when the step before it was decided', () => {
    const decided = at('2026-10-03T11:00:00Z')
    expect(
      waitingSince({ step: 2, createdAt: created }, [{ step: 1, decidedAt: decided }]),
    ).toEqual(decided)
  })

  it('ignores a resubmitted timesheet’s older decisions', () => {
    const resubmitted = at('2026-10-05T09:00:00Z')
    expect(
      waitingSince({ step: 3, createdAt: resubmitted }, [
        { step: 1, decidedAt: at('2026-10-02T09:00:00Z') },
        { step: 2, decidedAt: at('2026-10-03T09:00:00Z') },
      ]),
    ).toEqual(resubmitted)
  })
})

describe('timesheetReminder', () => {
  // The church: periods end on a Saturday and are due the following Tuesday;
  // reminded two days before the period ends.
  const periodEnd = day('2026-10-17')
  const dueDate = day('2026-10-20')
  const r = (today: string) => timesheetReminder({ today: day(today), periodEnd, dueDate, leadDays: 2 })

  it('says nothing until the lead time', () => {
    expect(r('2026-10-14')).toBeNull()
  })

  it('is due from two days before the period ends until the due date', () => {
    expect(r('2026-10-15')).toBe('DUE')
    expect(r('2026-10-17')).toBe('DUE')
    expect(r('2026-10-20')).toBe('DUE')
  })

  it('is overdue the day after the due date', () => {
    expect(r('2026-10-21')).toBe('OVERDUE')
  })
})

describe('hourIn', () => {
  it('reads the hour in the org’s timezone, not the server’s', () => {
    expect(hourIn('America/New_York', at('2026-10-07T11:30:00Z'))).toBe(7)
    expect(hourIn('America/New_York', at('2026-01-07T04:00:00Z'))).toBe(23)
    expect(hourIn('UTC', at('2026-10-07T00:00:00Z'))).toBe(0)
  })
})

describe('notificationSettingsInput', () => {
  const form = {
    mailFromAddress: ' Time@Example.TEST ',
    type_APPROVAL_WAITING: 'true',
    type_TIMESHEET_DUE: 'on',
    approvalReminderAfterDays: '7',
    approvalReminderIntervalHours: '24',
    approvalEscalateAfterDays: '3',
    approvalEscalateIntervalHours: '4',
    timesheetReminderDaysBeforePeriodEnd: '2',
    approverDigestHour: '7',
  }

  it('reads the form', () => {
    const parsed = notificationSettingsInput.parse(form)
    expect(parsed).toMatchObject({
      mailFromAddress: 'time@example.test',
      notificationTypesEnabled: ['APPROVAL_WAITING', 'TIMESHEET_DUE'],
      approvalEscalateIntervalHours: 4,
    })
  })

  it('treats a blank address as no email', () => {
    expect(notificationSettingsInput.parse({ ...form, mailFromAddress: '' }).mailFromAddress).toBeNull()
  })

  it('refuses something that is not an address', () => {
    expect(notificationSettingsInput.safeParse({ ...form, mailFromAddress: 'time' }).success).toBe(false)
  })

  it('refuses an interval of zero hours, which would never advance', () => {
    expect(
      notificationSettingsInput.safeParse({ ...form, approvalEscalateIntervalHours: '0' }).success,
    ).toBe(false)
    expect(notificationSettingsInput.safeParse({ ...form, approverDigestHour: '24' }).success).toBe(
      false,
    )
  })
})

describe('preferencesInput', () => {
  it('turns unchecked boxes into false, for every type', () => {
    const parsed = preferencesInput.parse({ push_REQUEST_DECIDED: 'true', approvalDigest: 'on' })
    expect(parsed.approvalDigest).toBe(true)
    expect(parsed.preferences).toHaveLength(NOTIFICATION_TYPES.length)
    expect(parsed.preferences.find((p) => p.type === 'REQUEST_DECIDED')).toEqual({
      type: 'REQUEST_DECIDED',
      push: true,
      email: false,
    })
    expect(parsed.preferences.find((p) => p.type === 'APPROVAL_WAITING')).toEqual({
      type: 'APPROVAL_WAITING',
      push: false,
      email: false,
    })
  })
})
