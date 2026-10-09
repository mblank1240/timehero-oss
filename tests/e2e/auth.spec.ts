import { expect, test, type Page } from '@playwright/test'

import { ADMIN, ADMIN_NAME } from './people'

/**
 * Seeded accounts — see prisma/seed.ts.
 */
const EMPLOYEE = 'custodian@example.test'
const TERMINATED = 'former@example.test'

/**
 * Signing in is a client-side action once hydrated, so the click resolves
 * before the navigation does. Callers that go straight to another page would
 * otherwise race the session cookie and bounce back to /signin.
 */
async function signIn(page: Page, email: string, expectSuccess = true) {
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  if (expectSuccess) await page.waitForURL('/')
  else await page.waitForURL(/\/signin\?error=/)
}

/**
 * Form errors only. A bare getByRole('alert') also matches Next's route
 * announcer, which appears once the client router hydrates.
 */
function formAlert(page: Page) {
  return page.locator('p[role="alert"], span[role="alert"]')
}

test.describe('authentication', () => {
  test('an unauthenticated visitor is sent to sign-in', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/signin/)
    await expect(page.getByRole('heading', { name: 'Sign in to TimeHero' })).toBeVisible()
  })

  test('an unauthenticated visitor cannot reach the admin area', async ({ page }) => {
    await page.goto('/admin/employees')
    await expect(page).toHaveURL(/\/signin/)
  })

  test('an employee can sign in and see their dashboard', async ({ page }) => {
    await signIn(page, EMPLOYEE)
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: /Welcome, Sam/ })).toBeVisible()
  })

  // These assert on the visible message, not just the URL. An earlier version
  // checked the URL alone and passed while the page was actually rendering an
  // unhandled CredentialsSignin error.
  test('a terminated employee is refused with an explanation', async ({ page }) => {
    await signIn(page, TERMINATED, false)
    await expect(page).toHaveURL(/\/signin\?error=/)
    await expect(formAlert(page)).toContainText('No active employee')
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeHidden()
  })

  test('an unknown account is refused with an explanation', async ({ page }) => {
    await signIn(page, 'nobody@example.test', false)
    await expect(page).toHaveURL(/\/signin\?error=/)
    await expect(formAlert(page)).toContainText('No active employee')
  })

  test('a failed sign-in shows no unhandled error', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    await signIn(page, 'nobody@example.test', false)
    await expect(formAlert(page)).toBeVisible()

    expect(pageErrors).toEqual([])
  })
})

test.describe('authorization', () => {
  test('a non-admin employee is redirected away from the admin area', async ({ page }) => {
    await signIn(page, EMPLOYEE)
    await expect(page).toHaveURL('/')

    await page.goto('/admin/employees')
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: /Welcome, Sam/ })).toBeVisible()
  })

  test('a non-admin employee sees no admin navigation', async ({ page }) => {
    await signIn(page, EMPLOYEE)
    await expect(page.getByRole('link', { name: 'Administration' })).toBeHidden()
    await expect(page.getByRole('link', { name: 'Departments' })).toBeHidden()
  })

  test('an admin can reach the employee list', async ({ page }) => {
    await signIn(page, ADMIN)
    await page.getByRole('link', { name: 'Administration' }).click()
    await expect(page).toHaveURL('/admin/employees')
    await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sam Okafor' })).toBeVisible()
  })

  test('an admin cannot change their own access', async ({ page }) => {
    await signIn(page, ADMIN)
    await page.goto('/admin/employees')
    await page.getByRole('link', { name: ADMIN_NAME }).click()

    // Their own record shows it, and offers nothing to change it with.
    await expect(page.getByText('Changed by someone who manages access.')).toBeVisible()
    await expect(page.getByLabel('Access')).toBeHidden()
  })

  test('an admin gives someone else an access role', async ({ page }) => {
    await signIn(page, ADMIN)
    await page.goto('/admin/employees')
    await page.getByRole('link', { name: 'Sam Okafor' }).click()
    await expect(page.getByLabel('Access')).toBeVisible()
    await expect(page.getByLabel('Access').getByRole('option', { name: 'Finance' })).toBeAttached()
  })
})

test.describe('employee management', () => {
  test('an admin can create an employee and see them listed', async ({ page }) => {
    // The surname is unique per run, not just the email. Rows persist in a
    // local database, so a fixed name matches every employee a previous run
    // left behind and trips Playwright's strict mode.
    const stamp = Date.now()
    const lastName = `McTestface${stamp}`
    const email = `e2e-${stamp}@example.test`

    await signIn(page, ADMIN)
    await page.goto('/admin/employees/new')

    await page.getByLabel('First name').fill('Testy')
    await page.getByLabel('Last name').fill(lastName)
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Hire date').fill('2026-01-05')
    await page.getByRole('button', { name: 'Create employee' }).click()

    await expect(page).toHaveURL('/admin/employees')
    await expect(page.getByRole('link', { name: `Testy ${lastName}` })).toBeVisible()
  })

  test('a duplicate email is rejected with a readable message', async ({ page }) => {
    await signIn(page, ADMIN)
    await page.goto('/admin/employees/new')

    await page.getByLabel('First name').fill('Duplicate')
    await page.getByLabel('Last name').fill('Person')
    await page.getByLabel('Email').fill(EMPLOYEE)
    await page.getByLabel('Hire date').fill('2026-01-05')
    await page.getByRole('button', { name: 'Create employee' }).click()

    await expect(formAlert(page)).toContainText('already exists')
  })
})
