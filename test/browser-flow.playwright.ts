import { expect, test, type Page } from '@playwright/test';

const demoUrl = process.env.FLOWKIT_DEMO_URL ?? 'http://localhost:3012';
const password = 'Acme-Demo-Only-2026!';

type ReviewDecision = 'approve' | 'reject';

async function signIn(page: Page, role: 'employee' | 'manager') {
  await page.goto(`${demoUrl}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(`${role}@acme-demo.example.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/organizations$/);
  await page.getByRole('button', { name: 'Use Acme Demo' }).click();
  await expect(page.getByRole('banner')).toContainText(role === 'employee' ? 'employee' : 'manager');
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function createAndSubmitMultiDayLeave(page: Page): Promise<string> {
  await signIn(page, 'employee');
  await page.goto(`${demoUrl}/requests/new`);
  await page.getByLabel('Start date').fill('2026-08-17');
  await page.getByLabel('End date').fill('2026-08-21');
  await page.getByLabel('Business days').fill('5');
  await page.getByLabel('Available balance').fill('12');
  await page.getByLabel('Reason').fill(`Browser reference journey ${Date.now()}`);
  await page.getByRole('button', { name: 'Create request' }).click();
  await expect(page.getByRole('button', { name: 'Submit request' })).toBeVisible();

  const requestId = (await page.getByTestId('request-id').textContent())?.trim();
  if (!requestId) throw new Error('FlowKit did not return a leave request identifier.');
  await page.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.getByTestId('request-stage')).toHaveText('Manager review');
  return requestId;
}

async function reviewLeave(page: Page, decision: ReviewDecision): Promise<string> {
  const requestId = await createAndSubmitMultiDayLeave(page);
  await signOut(page);
  await signIn(page, 'manager');
  await page.goto(`${demoUrl}/tasks`);

  const task = page.locator('[data-task-row]', { hasText: requestId });
  await expect(task.getByRole('button', { name: 'Claim task' })).toBeVisible();
  await task.getByRole('button', { name: 'Claim task' }).click();
  await task.getByRole('link', { name: `Open ${requestId}` }).click();

  const buttonName = decision === 'approve' ? 'Approve request' : 'Reject request';
  await page.getByRole('button', { name: buttonName }).click();
  await expect(page.getByTestId('request-stage')).toHaveText(decision === 'approve' ? 'Approved' : 'Rejected');
  await expect(page.getByRole('list', { name: 'Request activity' })).toContainText(decision === 'approve' ? 'Approved' : 'Rejected');
  await expect(page.locator('body')).not.toContainText(/FAAN|AVSEC|aviation security/i);
  return requestId;
}

test('employee submits multi-day leave and its assigned manager claims then approves it', async ({ page }) => {
  const requestId = await reviewLeave(page, 'approve');
  await signOut(page);
  await signIn(page, 'employee');
  await page.goto(`${demoUrl}/notifications`);
  await expect.poll(
    () => page.getByRole('region', { name: 'Notifications' }).textContent(),
    { timeout: 30_000 },
  ).toContain(requestId);
});

test('the assigned manager can reject a claimed multi-day request', async ({ page }) => {
  await reviewLeave(page, 'reject');
});

test('direct notification navigation stays an SPA document while its API failure is visible', async ({ page }) => {
  await signIn(page, 'employee');
  await page.route('**/api/workspace/notifications', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Delivery history is temporarily unavailable.' }) }));
  await page.goto(`${demoUrl}/notifications`);
  await expect(page.getByRole('alert')).toContainText('Delivery history is temporarily unavailable.');
  await expect(page.getByRole('link', { name: 'Return to overview' })).toBeVisible();
});
