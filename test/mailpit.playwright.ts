import { expect, test } from '@playwright/test';

const demoUrl = process.env.FLOWKIT_DEMO_URL ?? 'http://localhost:3012';
const mailpitUrl = process.env.FLOWKIT_DEMO_MAILPIT_URL ?? 'http://localhost:8025';
const password = 'Acme-Demo-Only-2026!';

async function signIn(page: import('@playwright/test').Page, role: 'employee' | 'manager') {
  await page.goto(`${demoUrl}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(`${role}@acme-demo.example.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Use Acme Demo' }).click();
}

test('Mailpit exposes an approval email from a real BetterAuth browser session', async ({ page, request }) => {
  await signIn(page, 'employee');
  await page.goto(`${demoUrl}/requests/new`);
  await page.getByLabel('Start date').fill('2026-08-17');
  await page.getByLabel('End date').fill('2026-08-21');
  await page.getByLabel('Business days').fill('5');
  await page.getByLabel('Available balance').fill('12');
  await page.getByLabel('Reason').fill(`Mailpit reference journey ${Date.now()}`);
  await page.getByRole('button', { name: 'Create request' }).click();
  const requestId = (await page.getByTestId('request-id').textContent())?.trim();
  if (!requestId) throw new Error('FlowKit did not return a leave request identifier.');
  await page.getByRole('button', { name: 'Submit request' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, 'manager');
  await page.goto(`${demoUrl}/tasks`);
  const task = page.locator('[data-task-row]', { hasText: requestId });
  await task.getByRole('button', { name: 'Claim task' }).click();
  await task.getByRole('link', { name: `Open ${requestId}` }).click();
  await page.getByRole('button', { name: 'Approve request' }).click();

  await expect.poll(async () => {
    const response = await request.get(`${mailpitUrl}/api/v1/messages`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json() as { messages?: Array<{ Subject?: string }> };
    return body.messages?.some((message) => message.Subject?.includes(requestId) && /approved/i.test(message.Subject)) ?? false;
  }, { timeout: 30_000 }).toBe(true);
});
