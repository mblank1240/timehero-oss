import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CurrentUser } from '@/lib/authz'
import { createAdjustment } from '@/lib/ledger/actions'

/**
 * An administrator may not post an adjustment to their own ledger. The
 * refusal comes before anything is read, so the database is stubbed only to
 * show that another employee gets past it.
 */
const ADMIN: CurrentUser = {
  id: 'admin_1',
  email: 'admin@example.test',
  firstName: 'Ada',
  lastName: 'Admin',
  permissions: ['MANAGE_LEDGER'],
  accessRoleName: 'Administrator',
  employmentType: 'SALARIED_EXEMPT',
  departmentId: null,
  standardMinutesPerDay: 480,
}

const { findEmployee } = vi.hoisted(() => ({ findEmployee: vi.fn() }))

vi.mock('@/lib/authz', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requirePermissionOrThrow: vi.fn(async () => ADMIN),
}))
vi.mock('@/lib/db', () => ({
  db: {
    employee: { findUnique: findEmployee },
    leaveType: { findUnique: vi.fn(async () => null) },
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(employeeId: string): FormData {
  const data = new FormData()
  data.set('employeeId', employeeId)
  data.set('leaveTypeId', 'type_1')
  data.set('effectiveDate', '2026-06-29')
  data.set('minutes', '480')
  data.set('reason', 'Opening balance imported from the spreadsheet')
  return data
}

describe('createAdjustment', () => {
  beforeEach(() => findEmployee.mockReset())

  it('refuses an administrator adjusting their own balance, before reading anything', async () => {
    const result = await createAdjustment(null, form(ADMIN.id))
    expect(result).toMatchObject({ ok: false, error: 'You cannot adjust your own balance.' })
    expect(findEmployee).not.toHaveBeenCalled()
  })

  it('goes on to check another employee', async () => {
    findEmployee.mockResolvedValue(null)
    const result = await createAdjustment(null, form('emp_2'))
    expect(result).toMatchObject({ ok: false, error: 'That employee no longer exists.' })
    expect(findEmployee).toHaveBeenCalledOnce()
  })
})
