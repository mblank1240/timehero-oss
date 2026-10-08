import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

const EMPLOYEE = 'custodian@example.test'

async function signIn(page: Page, email: string) {
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

/**
 * Form errors only. A bare getByRole('alert') also matches Next's route
 * announcer, which appears once the client router hydrates.
 */
function formAlert(page: Page) {
  return page.locator('p[role="alert"], span[role="alert"]')
}

const CONFIG_ROUTES = [
  '/admin/settings',
  '/admin/pay-schedules',
  '/admin/holidays',
  '/admin/leave-types',
  '/admin/leave-policies',
  '/admin/rollover',
]

test.describe('configuration access', () => {
  test('every config screen is closed to a non-admin', async ({ page }) => {
    await signIn(page, EMPLOYEE)

    for (const route of CONFIG_ROUTES) {
      await page.goto(route)
      await expect(page, `${route} should redirect a non-admin`).toHaveURL('/')
    }
  })

  test('every config screen is reachable by an admin', async ({ page }) => {
    await signIn(page, ADMIN)

    for (const route of CONFIG_ROUTES) {
      await page.goto(route)
      await expect(page, `${route} should load for an admin`).toHaveURL(route)
      await expect(page.locator('h1')).toBeVisible()
    }
  })
})

test.describe('seeded configuration', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN)
  })

  test('the three leave types are present with the right accrual eligibility', async ({
    page,
  }) => {
    await page.goto('/admin/leave-types')

    await expect(page.getByText('PTO', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Sick', { exact: false }).first()).toBeVisible()

    // Comp time must be exempt-only — the FLSA constraint, visible in the UI.
    const comp = page.locator('li', { hasText: 'Comp Time' })
    await expect(comp).toContainText('Salaried (exempt) only')
    await expect(comp).toContainText('does not roll over')
  })

  test('PTO rolls over five of the employee own days', async ({ page }) => {
    await page.goto('/admin/rollover')

    const pto = page.locator('section', { hasText: 'PTO' }).first()
    await expect(pto).toContainText("5 days of the employee's own schedule")
  })

  test('the December comp window is configured', async ({ page }) => {
    await page.goto('/admin/rollover')

    const windowRow = page.locator('li', { hasText: 'December comp grace period' })
    await expect(windowRow).toContainText('Earned 1 December – 31 December')
    await expect(windowRow).toContainText('usable until 28 February the following year')
  })

  test('policies grant the full allotment after the waiting period', async ({ page }) => {
    await page.goto('/admin/leave-policies')

    const standard = page.locator('li', { hasText: 'PTO — Standard' })
    await expect(standard).toContainText('90-day wait')
    await expect(standard).toContainText('full allotment once the waiting period ends')
  })

  test('the biweekly schedule has generated future periods', async ({ page }) => {
    await page.goto('/admin/pay-schedules')

    await expect(page.getByText('26 periods a year')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Next periods' })).toBeVisible()
  })
})

test.describe('configuration editing', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN)
  })

  test('a leave increment finer than the timesheet increment is rejected', async ({
    page,
  }) => {
    await page.goto('/admin/settings')

    await page.getByLabel('Minimum leave request (minutes)').fill('5')
    await page.getByLabel('Timesheet increment (minutes)').fill('15')
    await page.getByRole('button', { name: 'Save settings' }).click()

    await expect(formAlert(page)).toBeVisible()
    await expect(page.locator('body')).toContainText(
      'cannot be finer than the timesheet increment',
    )
  })

  test('an impossible calendar date is rejected', async ({ page }) => {
    await page.goto('/admin/settings')

    await page.getByLabel('Start month').selectOption('2')
    await page.getByLabel('Start day').fill('30')
    await page.getByRole('button', { name: 'Save settings' }).click()

    await expect(page.locator('body')).toContainText('does not exist in the chosen month')
  })

  test('a holiday can be added and removed', async ({ page }) => {
    // Unique date as well as name: holidays are unique per date, so a fixed
    // one collides with whatever an earlier local run left behind.
    const stamp = Date.now()
    const name = `Test Holiday ${stamp}`
    const day = String((stamp % 28) + 1).padStart(2, '0')

    await page.goto('/admin/holidays')
    await page.getByLabel('Date').fill(`2029-06-${day}`)
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Add holiday' }).click()

    const row = page.locator('li', { hasText: name })
    await expect(row).toBeVisible()

    // Removal is two steps: the first click arms the button, the second runs
    // it. No native dialog is involved.
    await row.getByRole('button', { name: 'Remove' }).click()
    await row.getByRole('button', { name: 'Confirm removal' }).click()

    await expect(page.locator('li', { hasText: name })).toBeHidden()
  })

  test('a removal can be backed out of', async ({ page }) => {
    await page.goto('/admin/holidays')

    const row = page.locator('li', { hasText: 'Christmas Day' })
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(row.getByRole('button', { name: 'Confirm removal' })).toBeVisible()

    await row.getByRole('button', { name: 'Cancel' }).click()

    await page.reload()
    await expect(page.locator('li', { hasText: 'Christmas Day' })).toBeVisible()
  })

  test('two holidays cannot share a date', async ({ page }) => {
    await page.goto('/admin/holidays')

    await page.getByLabel('Date').fill('2026-12-25')
    await page.getByLabel('Name').fill('Duplicate Christmas')
    await page.getByRole('button', { name: 'Add holiday' }).click()

    await expect(formAlert(page)).toContainText('already recorded on that date')
  })

  test('a policy ceiling below its own allotment is rejected', async ({ page }) => {
    await page.goto('/admin/leave-policies')

    await page.getByLabel('Policy name').fill(`Bad Ceiling ${Date.now()}`)
    await page.getByLabel('Annual allotment (minutes)').fill('7200')
    await page.getByLabel('Waiting period (days)').fill('0')
    await page.getByLabel('Balance ceiling (minutes)').fill('2400')
    await page.getByRole('button', { name: 'Add policy' }).click()

    await expect(page.locator('body')).toContainText(
      'ceiling cannot be lower than the annual allotment',
    )
  })

  test('a carryover window that ends before it starts is rejected', async ({ page }) => {
    await page.goto('/admin/rollover')

    const panel = page.locator('details', { hasText: 'Add a window for PTO' }).first()
    await panel.locator('summary').click()

    await panel.getByLabel('Name').fill('Backwards window')
    await panel.getByLabel('From month').selectOption('12')
    await panel.getByLabel('From day').fill('1')
    await panel.getByLabel('To month').selectOption('3')
    await panel.getByLabel('To day').fill('1')
    await panel.getByLabel('Month', { exact: true }).selectOption('4')
    await panel.getByLabel('Day', { exact: true }).fill('1')
    await panel.getByLabel('Years later').fill('1')
    await panel.getByRole('button', { name: 'Add window' }).click()

    await expect(page.locator('body')).toContainText('ends before it starts')
  })
})
