import { expect, test, type Page } from '@playwright/test'

import { ADMIN } from './people'

async function signIn(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto('/signin')
  await page.getByLabel('Employee email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}

test('an administrator registers Google Workspace domains and removes them again', async ({
  page,
}) => {
  await signIn(page, ADMIN)
  await page.goto('/admin/directory')
  await expect(page.getByRole('heading', { name: 'Sign-in and directory' })).toBeVisible()
  // No Entra app in development: the page says so rather than offering a dead button.
  await expect(page.getByText('Microsoft sign-in is not configured for this deployment.')).toBeVisible()

  await page.getByLabel('Workspace domains').fill('not a domain')
  await page.getByRole('button', { name: 'Register domains' }).click()
  await expect(page.getByText('Enter domains such as example.org.')).toBeVisible()

  await page.getByLabel('Workspace domains').fill('Church.example, school.example')
  await page.getByRole('button', { name: 'Register domains' }).click()
  await expect(page.getByText('Registered domains: church.example, school.example.')).toBeVisible()

  await page.getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Remove Google Workspace' }).click()
  await expect(page.getByText('Register your Workspace domains')).toBeVisible()
})

test('an employee record shows its pay schedule, leave policies and sign-ins', async ({ page }) => {
  await signIn(page, ADMIN)
  await page.goto('/admin/employees')
  await page.getByRole('link', { name: 'Sam Okafor' }).click()
  await expect(page.getByLabel('Pay schedule')).toHaveValue(/.+/)
  await expect(page.getByRole('heading', { name: 'Leave policies' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign-in' })).toBeVisible()
})
