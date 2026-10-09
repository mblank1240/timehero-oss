import { describe, expect, it } from 'vitest'

import {
  ADMIN_SECTIONS,
  PERMISSION_INFO,
  PERMISSIONS,
  REPORT_SECTIONS,
  can,
  effectivePermissions,
  holdersWhere,
  outranksOrEquals,
  sectionsFor,
  type Permission,
} from '@/lib/permissions'

const holder = (...permissions: Permission[]) => ({ permissions })

describe('effectivePermissions', () => {
  it('gives an ordinary employee nothing', () => {
    expect(effectivePermissions(null)).toEqual([])
  })

  it('gives Administrator every permission', () => {
    expect(effectivePermissions({ permissions: [], allPermissions: true })).toEqual(PERMISSIONS)
  })

  it('brings viewing with acting on time records', () => {
    expect(
      effectivePermissions({ permissions: ['MANAGE_TIME_RECORDS'], allPermissions: false }),
    ).toEqual(['VIEW_TIME_RECORDS', 'MANAGE_TIME_RECORDS'])
  })

  it('grants a developer role its admin areas and no time records', () => {
    const developer = effectivePermissions({
      permissions: ['MANAGE_JOBS', 'MANAGE_DIRECTORY', 'MANAGE_SETTINGS', 'MANAGE_POLICIES'],
      allPermissions: false,
    })
    const user = { permissions: developer }
    expect(can(user, 'VIEW_TIME_RECORDS')).toBe(false)
    expect(can(user, 'MANAGE_LEDGER')).toBe(false)
    expect(sectionsFor(user, REPORT_SECTIONS)).toEqual([])
    expect(sectionsFor(user, ADMIN_SECTIONS).map((s) => s.href)).toEqual([
      '/admin/pay-schedules',
      '/admin/holidays',
      '/admin/leave-types',
      '/admin/leave-policies',
      '/admin/rollover',
      '/admin/directory',
      '/admin/jobs',
      '/admin/notifications',
      '/admin/settings',
    ])
  })
})

describe('the catalogue', () => {
  it('describes every permission once', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length)
    for (const p of PERMISSIONS) expect(PERMISSION_INFO[p].label).toBeTruthy()
  })

  it('puts every admin section and report behind a known permission', () => {
    for (const s of [...ADMIN_SECTIONS, ...REPORT_SECTIONS]) {
      expect(PERMISSIONS).toContain(s.permission)
    }
  })
})

describe('outranksOrEquals', () => {
  it('lets someone edit a person holding a subset of their permissions', () => {
    expect(outranksOrEquals(holder('MANAGE_EMPLOYEES', 'REPORT_LEAVE'), holder('REPORT_LEAVE'))).toBe(
      true,
    )
    expect(outranksOrEquals(holder('MANAGE_EMPLOYEES'), holder())).toBe(true)
  })

  it('refuses a person holding anything the editor does not', () => {
    expect(outranksOrEquals(holder('MANAGE_EMPLOYEES'), holder('MANAGE_ACCESS'))).toBe(false)
    expect(outranksOrEquals(holder('MANAGE_EMPLOYEES'), { permissions: PERMISSIONS })).toBe(false)
  })
})

describe('holdersWhere', () => {
  it('finds Administrator and any role granting the permission', () => {
    expect(holdersWhere(['MANAGE_ACCESS'])).toEqual({
      accessRole: {
        OR: [{ allPermissions: true }, { permissions: { hasSome: ['MANAGE_ACCESS'] } }],
      },
    })
  })

  it('finds those who hold a permission by implication', () => {
    const where = holdersWhere(['VIEW_TIME_RECORDS'])
    expect(where.accessRole.OR[1]).toEqual({
      permissions: { hasSome: ['VIEW_TIME_RECORDS', 'MANAGE_TIME_RECORDS'] },
    })
  })
})
