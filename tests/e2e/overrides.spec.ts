import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

/**
 * The administrator's manual overrides, through the screens: recording leave
 * for someone, amending it, and editing configuration that already exists.
 * The rules behind them are covered by the integration suite; this proves
 * the pages reach them.
 */
const EMPLOYEE = 'custodian@example.test' // Sam Okafor, hourly

async function signIn(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

/** A weekday a few weeks out, different on each run. */
function candidateDays(): string[] {
  const base = Date.now() + (14 + (Date.now() % 30)) * 86_400_000
  const days: string[] = []
  for (let i = 0; days.length < 10; i++) {
    const date = new Date(base + i * 86_400_000)
    const weekday = date.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days.push(date.toISOString().slice(0, 10))
  }
  return days
}

test('an administrator records sick leave for an employee, then amends it', async ({ page }) => {
  await signIn(page, ADMIN)
  await page.goto('/admin/employees')
  await page.getByRole('link', { name: /Okafor/ }).first().click()
  await page.getByRole('link', { name: 'Record leave' }).click()
  await expect(page.getByRole('heading', { name: /Record leave for Sam Okafor/ })).toBeVisible()

  const leaveType = page.getByLabel('Leave type')
  const sick = await leaveType.locator('option', { hasText: /^Sick/ }).getAttribute('value')
  await leaveType.selectOption(sick ?? '')

  let date = ''
  for (const candidate of candidateDays()) {
    await page.getByLabel('First day').fill(candidate)
    await page.getByLabel('Last day').fill(candidate)
    if ((await page.locator(`select[name="day.${candidate}"]`).count()) > 0) {
      date = candidate
      break
    }
  }
  expect(date, 'no non-holiday weekday found').not.toBe('')
  await page.locator(`select[name="day.${date}"]`).selectOption({ index: 1 })

  await page.getByLabel('Record it as already approved').check()
  await page.getByLabel('Reason').fill('Called in sick')
  await page.getByRole('button', { name: 'Record leave' }).click()

  await expect(page).toHaveURL(/\/requests\/(?!new$)[a-z0-9]+$/)
  await expect(page.getByText('Approved').first()).toBeVisible()

  await page.getByRole('link', { name: 'Amend this request' }).click()
  await expect(page.getByRole('heading', { name: /Amend Sam Okafor/ })).toBeVisible()
  // Recorded as the shortest amount; the amendment makes it the next one up.
  await page.locator(`select[name="day.${date}"]`).selectOption({ index: 2 })
  await page.getByLabel('Reason').fill('Was out the whole day')
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect(page).toHaveURL(/\/requests\/[a-z0-9]+$/)
  await expect(page.getByText('Approved').first()).toBeVisible()
  await expect(page.getByText('given back').first()).toBeVisible()
})

test('an employee cannot reach the administrator’s leave screens', async ({ page }) => {
  await signIn(page, EMPLOYEE)
  await page.goto('/admin/employees')
  await expect(page).toHaveURL('/')
})

test('an existing leave type can be edited, and the change is kept', async ({ page }) => {
  await signIn(page, ADMIN)
  await page.goto('/admin/leave-types')
  await page.getByRole('link', { name: 'Edit Comp Time' }).click()
  await expect(page.getByRole('heading', { name: 'Edit Comp Time' })).toBeVisible()

  const sortOrder = page.getByLabel('Sort order')
  const before = await sortOrder.inputValue()
  const next = before === '7' ? '8' : '7'
  await sortOrder.fill(next)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Sort order')).toHaveValue(next)

  // Put it back, so the suite leaves the seeded order as it found it.
  await page.getByLabel('Sort order').fill(before)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
})

test('a policy assignment can be changed in place', async ({ page }) => {
  await signIn(page, ADMIN)
  await page.goto('/admin/employees')
  await page.getByRole('link', { name: /Okafor/ }).first().click()

  const row = page.getByRole('listitem').filter({ hasText: 'PTO: Standard' })
  await row.getByText('Edit').click()
  const override = row.getByLabel('Annual minutes override')
  await override.fill('5280')
  await row.getByRole('button', { name: 'Save assignment' }).click()
  await expect(row.getByText('Saved.')).toBeVisible()

  await page.reload()
  await expect(
    page.getByRole('listitem').filter({ hasText: 'PTO: Standard' }),
  ).toContainText('5280 minutes a year')

  // And clear it again.
  const again = page.getByRole('listitem').filter({ hasText: 'PTO: Standard' })
  await again.getByText('Edit').click()
  await again.getByLabel('Annual minutes override').fill('')
  await again.getByRole('button', { name: 'Save assignment' }).click()
  await expect(again.getByText('Saved.')).toBeVisible()
})
