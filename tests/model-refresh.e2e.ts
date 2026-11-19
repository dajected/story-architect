import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('refreshes OpenRouter suggestions without clearing a model role draft', async ({ page, request }) => {
  let model = 'example/old-model';
  let unavailable = false;
  const provider = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/v1/models') {
      res.end(JSON.stringify({ data: { endpoints: [] } }));
      return;
    }
    if (unavailable) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { message: 'Catalog unavailable' } }));
      return;
    }
    res.end(JSON.stringify({ data: [{ id: model }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));

  try {
    const response = await request.post('/api/connections', {
      data: {
        name: 'Test OpenRouter',
        kind: 'openrouter',
        baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      },
    });
    expect(response.ok()).toBeTruthy();
    const { connection } = await response.json();
    const initialRefresh = await request.post(`/api/connections/${connection.id}/refresh-models`);
    expect(initialRefresh.ok()).toBeTruthy();

    await page.goto('/settings?tab=models');
    await page.getByRole('combobox', { name: 'Default model connection' }).selectOption(connection.id);
    const input = page.getByLabel('Default model model', { exact: true });
    await input.fill('example/custom-model');
    const options = page.locator('#models-global-default option');
    await expect(options).toHaveText(['example/old-model']);

    model = 'example/new-model';
    const refresh = page.getByRole('button', { name: 'Refresh models for Test OpenRouter' });
    await refresh.click();
    await expect(page.getByRole('status').filter({ hasText: 'Discovered 1 model.' })).toBeVisible();
    await expect(options).toHaveText(['example/new-model']);
    await expect(input).toHaveValue('example/custom-model');

    unavailable = true;
    await refresh.click();
    await expect(page.getByRole('alert')).toContainText('Catalog unavailable');
    await expect(options).toHaveText(['example/new-model']);
    await expect(input).toHaveValue('example/custom-model');
    await expect(refresh).toBeEnabled();
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
