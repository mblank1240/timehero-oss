import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

/**
 * Employee types end to end: an administrator adds one, then creates an
 * employee from it and lands on their record with the type's policies
 * already assigned. The seeded types come from prisma/config/example.json.
 */

async function signIn(page: Page, email: string) {
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

test.describe('employee types', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN)
  })

  test('the seeded types are listed with their defaults', async ({ page }) => {
    await page.goto('/admin/employee-types')

    const pastor = page.locator('li', { hasText: 'Pastor' }).first()
    await expect(pastor).toContainText('Salaried (exempt)')
    await expect(pastor).toContainText('PTO: Senior Staff')
    await expect(page.locator('li', { hasText: 'Associate' }).first()).toContainText('Hourly')
  })

  test('an employee created from a type starts on its policies', async ({ page }) => {
    // The local database outlives a run, so names are stamped to stay unique.
    const stamp = Date.now()
    const typeName = `Sexton ${stamp}`
    const lastName = `Typed${stamp}`

    await page.goto('/admin/employee-types')
    await page.getByLabel('Name', { exact: true }).fill(typeName)
    await page.getByLabel('Employment type').selectOption('HOURLY')
    await page.getByLabel('PTO', { exact: true }).selectOption({ label: '5+ Years' })
    await page.getByLabel('Sick', { exact: true }).selectOption({ label: 'Standard' })
    await page.getByRole('button', { name: 'Add employee type' }).click()

    const row = page.locator('li', { hasText: typeName })
    await expect(row).toContainText('Hourly')
    await expect(row).toContainText('PTO: 5+ Years · Sick: Standard')

    await page.goto('/admin/employees/new')
    const type = page.getByLabel('Employee type')
    const employment = page.getByLabel('Employment type')
    // Choosing a type pre-fills the employment type once the form has
    // hydrated; retried, because a choice made before that is not seen.
    await expect(async () => {
      await type.selectOption({ label: 'Pastor' })
      await expect(employment).toHaveValue('SALARIED_EXEMPT', { timeout: 500 })
      await type.selectOption({ label: typeName })
      await expect(employment).toHaveValue('HOURLY', { timeout: 500 })
    }).toPass()

    await page.getByLabel('First name').fill('Terry')
    await page.getByLabel('Last name').fill(lastName)
    await page.getByLabel('Email').fill(`e2e-type-${stamp}@example.test`)
    await page.getByLabel('Hire date').fill('2026-02-02')
    await page.getByRole('button', { name: 'Create employee' }).click()

    await expect(page).toHaveURL(/\/admin\/employees\/[^/]+\?created=1$/)
    await expect(page.getByRole('status')).toContainText(
      `Their leave policies below come from the ${typeName} type`,
    )
    const policies = page.locator('section', { hasText: 'Leave policies' })
    await expect(policies).toContainText('PTO: 5+ Years')
    await expect(policies).toContainText('Sick: Standard')
    await expect(policies).toContainText('from Mon, Feb 2, 2026')

    await page.goto('/admin/employees')
    await expect(
      page.getByRole('row', { name: new RegExp(`Terry ${lastName}`) }),
    ).toContainText(typeName)
  })
})
