import { describe, expect, it } from 'vitest'

import { JOB_CADENCE, JOB_NAMES } from '@/lib/jobs/catalog'
import { GRACE_MS, overdueJobs } from '@/lib/jobs/health'

const HOUR = 60 * 60 * 1000
const now = new Date('2026-11-04T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

/** Every job succeeded `ms` before now. */
const allAt = (ms: number) => new Map(JOB_NAMES.map((name) => [name, ago(ms)] as [string, Date]))

describe('overdueJobs', () => {
  it('reports nothing when every job ran within the hour', () => {
    expect(overdueJobs(allAt(HOUR / 2), now)).toEqual([])
  })

  it('reports every job on a deployment where nothing has ever run', () => {
    const overdue = overdueJobs(new Map(), now)
    expect(overdue.map((j) => j.jobName)).toEqual([...JOB_NAMES])
    expect(overdue.every((j) => j.lastSucceededAt === null)).toBe(true)
  })

  it('holds each job to its own cadence', () => {
    // Twenty hours since anything ran: late for an hourly job, fine for the rest.
    const overdue = overdueJobs(allAt(20 * HOUR), now)
    expect(overdue.map((j) => j.jobName)).toEqual(['send-notifications'])
    expect(overdue[0].cadence).toBe('hourly')
  })

  it('lets a daily job run late without alarm, but not skip a day', () => {
    const late = new Map(allAt(0))
    late.set('accrue-pay-period', ago(GRACE_MS.daily))
    expect(overdueJobs(late, now)).toEqual([])

    late.set('accrue-pay-period', ago(GRACE_MS.daily + 1))
    expect(overdueJobs(late, now).map((j) => j.jobName)).toEqual(['accrue-pay-period'])
  })

  it('gives the weekly job a week and a day', () => {
    const runs = new Map(allAt(0))
    runs.set('generate-pay-periods', ago(7 * 24 * HOUR))
    expect(overdueJobs(runs, now)).toEqual([])
  })

  it('has a cadence for every job', () => {
    expect(Object.keys(JOB_CADENCE).sort()).toEqual([...JOB_NAMES].sort())
  })
})
