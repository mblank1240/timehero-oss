import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CurrentUser } from '@/lib/authz'
import { updateEmployee } from '@/lib/employees/actions'
import { PERMISSIONS, type Permission } from '@/lib/permissions'

/**
 * Who may change whose access, from the employee form. Each refusal comes
 * before anything is written; the database is stubbed with the record being
 * edited, and a write would fail the test.
 */

function actor(id: string, permissions: Permission[]): CurrentUser {
  return {
    id,
    email: `${id}@example.test`,
    firstName: id,
    lastName: 'Test',
    permissions,
    accessRoleName: null,
    employmentType: 'SALARIED_EXEMPT',
    departmentId: null,
    standardMinutesPerDay: 480,
  }
}

const { current, findEmployee, transaction } = vi.hoisted(() => ({
  current: { user: null as CurrentUser | null },
  findEmployee: vi.fn(),
  transaction: vi.fn(async (_fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    throw new Error('nothing should be written')
  }),
}))

vi.mock('@/lib/authz', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  requirePermissionOrThrow: vi.fn(async () => current.user),
}))
vi.mock('@/lib/db', () => ({
  db: { employee: { findUnique: findEmployee }, $transaction: transaction },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

/** The employee being edited: holds `role`, if any. */
function target(
  id: string,
  accessRoleId: string | null,
  role: { permissions: Permission[]; allPermissions: boolean } | null,
) {
  findEmployee.mockImplementation(async (args: { select?: unknown }) =>
    args.select
      ? { accessRole: role }
      : { id, accessRoleId, employeeTypeId: null, email: `${id}@example.test` },
  )
}

function form(accessRoleId: string): FormData {
  const data = new FormData()
  for (const [k, v] of Object.entries({
    email: 'someone@example.test',
    firstName: 'Some',
    lastName: 'One',
    accessRoleId,
    employmentType: 'HOURLY',
    hireDate: '2024-01-01',
    standardMinutesPerDay: '480',
    isActive: 'true',
  })) {
    data.set(k, v)
  }
  return data
}

const ROLE_ID = 'cfinancerole1'
const OTHER_ROLE_ID = 'cotherrole1'

beforeEach(() => {
  findEmployee.mockReset()
  transaction.mockClear()
})

describe('updateEmployee and access', () => {
  it('refuses anyone changing their own access', async () => {
    current.user = actor('owner', [...PERMISSIONS])
    target('owner', ROLE_ID, { permissions: [], allPermissions: true })
    const result = await updateEmployee('owner', null, form(OTHER_ROLE_ID))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/your own access/) })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('refuses editing someone who holds a permission the editor does not', async () => {
    current.user = actor('hr', ['MANAGE_EMPLOYEES'])
    target('boss', ROLE_ID, { permissions: [], allPermissions: true })
    const result = await updateEmployee('boss', null, form(ROLE_ID))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/permissions you do not/) })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('keeps the role when the editor may not manage access, whatever the form posts', async () => {
    current.user = actor('hr', ['MANAGE_EMPLOYEES'])
    target('staff', null, null)
    let written: { accessRoleId?: string | null } | undefined
    transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        employee: {
          update: vi.fn(async ({ data }: { data: { accessRoleId: string | null } }) => {
            written = data
            return { id: 'staff', ...data }
          }),
          count: vi.fn(async () => 1),
        },
      }
      return fn(tx)
    })
    await updateEmployee('staff', null, form(ROLE_ID))
    expect(written?.accessRoleId).toBeNull()
  })
})
