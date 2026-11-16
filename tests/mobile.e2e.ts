import { test, expect, type Page, type Locator } from '@playwright/test';

test.use({isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: {width: 320, height: 700}});
let projectId: string;

test.beforeAll(async ({request}) => {
  const projectResponse = await request.post('/api/projects', {data: {title: 'Mobile regression', premise: 'A traveller returns to the harbour.'}});
  expect(projectResponse.ok()).toBeTruthy();
  const {project} = await projectResponse.json();
  projectId = project.id;
  const {revision} = await (await request.post(`/api/projects/${projectId}/outline/manual`)).json();
  const chapters = Array.from({length: 25}, (_, index) => ({id: index ? `${projectId}-${index}` : revision.chapters[0].id, title: `Journey ${index + 1}`, brief: 'The traveller follows the shore and discovers a new clue. '.repeat(4)}));
  expect((await request.put(`/api/projects/${projectId}/outline`, {data: {revisionId: revision.id, chapters}})).ok()).toBeTruthy();
  expect((await request.post(`/api/projects/${projectId}/outline/${revision.id}/approve`)).ok()).toBeTruthy();
  expect((await request.put(`/api/chapters/${chapters[0]!.id}/content`, {data: {content: 'The traveller walked along the shore.\n\n'.repeat(90)}})).ok()).toBeTruthy();
  expect((await request.post(`/api/projects/${projectId}/characters`, {data: {name: 'The traveller', appearance: 'A navy coat.'}})).ok()).toBeTruthy();
});

async function fits(page: Page, width: number) {
  expect(await page.evaluate(() => innerWidth)).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
}

async function bounded(panel: Locator, width: number) {
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
}

for (const width of [320, 390, 768]) {
  test(`mobile routes and settings stay within ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 700});
    for (const theme of ['light', 'dark']) {
      await page.addInitScript(value => {
        localStorage.setItem('reading-appearance-version', '1');
        localStorage.setItem('story-architect-theme', value);
      }, theme);
      for (const tab of ['connections', 'models', 'generation', 'prompts', 'image-connections', 'image-prompts']) {
        await page.goto(`/settings?tab=${tab}`);
        await expect(page.locator('.settings-content')).toBeVisible();
        await fits(page, width);
        if (theme === 'light' && width === 320 && tab === 'models') await page.screenshot({path: 'work/test-results/mobile-settings-models-320.png'});
      }
      for (const tab of ['manuscript', 'outline', 'cast', 'memory', 'lore', 'activity', 'images']) {
        await page.goto(`/projects/${projectId}?tab=${tab}`);
        await expect(page.locator('.workspace-topbar')).toBeVisible();
        await fits(page, width);
        if (width <= 720) expect((await page.locator('.workspace-topbar').boundingBox())!.height).toBeLessThan(130);
        if (theme === 'light' && width === 390) await page.screenshot({path: `work/test-results/mobile-${tab}-390.png`});
      }
      await page.goto('/');
      await expect(page.getByRole('heading', {name: 'Your library'})).toBeVisible();
      await fits(page, width);
    }
  });
}

test('320px sheets fit, dismiss outside, and preserve modal focus', async ({page}) => {
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  const tools = page.getByRole('button', {name: 'Chapter tools', exact: true});
  await tools.click();
  const menu = page.getByRole('dialog', {name: 'Chapter tools', exact: true});
  await bounded(menu, 320);
  await fits(page, 320);
  await menu.getByRole('button').last().focus();
  await page.keyboard.press('Tab');
  expect(await menu.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(tools).toBeFocused();
  await tools.click();
  await page.locator('.action-menu-layer').click({position: {x: 4, y: 4}});
  await expect(menu).toBeHidden();

  await page.getByRole('combobox', {name: 'Workspace section', exact: true}).selectOption('outline');
  await page.getByRole('button', {name: /^Work queue/}).click();
  const queue = page.getByRole('dialog', {name: 'Work queue', exact: true});
  await bounded(queue, 320);
  await fits(page, 320);
  await queue.getByRole('button', {name: 'Activity', exact: true}).click();
  await expect(queue).toBeHidden();
  await expect(page.getByRole('combobox', {name: 'Workspace section', exact: true})).toHaveValue('activity');
});

test('chapter and assistant drawers trap focus, close with Escape, and restore their triggers', async ({page}) => {
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  const chapters = page.getByRole('button', {name: 'Chapters, 1 of 25', exact: true});
  await chapters.click();
  const drawer = page.getByRole('dialog', {name: 'Chapters', exact: true});
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await drawer.getByRole('button').last().focus();
  await page.keyboard.press('Tab');
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(chapters).toBeFocused();
  await expect(page.locator('.chapter-sidebar')).toHaveAttribute('inert', '');
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

  const trigger = page.locator('.workspace-menu > button');
  await trigger.click();
  await page.locator('.workspace-submenu > summary').filter({hasText: 'Workspace'}).click();
  await page.getByRole('button', {name: 'Show assistant', exact: true}).click();
  const assistant = page.getByRole('dialog', {name: 'Assistant', exact: true});
  await expect(assistant).toHaveAttribute('aria-modal', 'true');
  expect(await assistant.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await assistant.getByRole('button').first().focus();
  await page.keyboard.press('Shift+Tab');
  expect(await assistant.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(assistant).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
});

test('outline edits survive collapse and settings controls stack on phones', async ({page}) => {
  await page.goto(`/projects/${projectId}?tab=outline`);
  const card = page.locator('.outline-chapter-card').first();
  await expect(card.locator('.outline-chapter-toggle')).toHaveAttribute('aria-expanded', 'false');
  expect((await card.boundingBox())!.height).toBeLessThan(180);
  await card.locator('.outline-chapter-toggle').click();
  await card.getByRole('textbox', {name: 'Chapter 1 brief', exact: true}).fill('A revised mobile brief.');
  await card.locator('.outline-chapter-toggle').click();
  await card.locator('.outline-chapter-toggle').click();
  await expect(card.getByRole('textbox', {name: 'Chapter 1 brief', exact: true})).toHaveValue('A revised mobile brief.');
  await page.goto('/settings?tab=models');
  const inputs = page.locator('.role-inputs').first();
  const select = await inputs.locator('select').first().boundingBox();
  const input = await inputs.locator('input').boundingBox();
  expect(input!.y).toBeGreaterThanOrEqual(select!.y + select!.height);
  await fits(page, 320);
});

test('idle queue polling backs off and pauses in hidden tabs', async ({page}) => {
  await page.clock.install();
  let requests = 0;
  await page.route(`**/api/projects/${projectId}/queue`, route => {
    requests++;
    return route.fulfill({json: {jobs: [], chapterBatch: null, portraitBatches: [], characters: []}});
  });
  await page.goto(`/projects/${projectId}?tab=activity`);
  await expect.poll(() => requests).toBe(1);
  await page.clock.fastForward(3000);
  expect(requests).toBe(1);
  await page.clock.fastForward(15000);
  await expect.poll(() => requests).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable: true, value: true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(60000);
  expect(requests).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {configurable: true, value: false});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requests).toBe(3);
});

test('desktop outside dismissal keeps focus on the clicked field', async ({page}) => {
  await page.setViewportSize({width: 1024, height: 700});
  await page.goto('/');
  const trigger = page.getByRole('button', {name: 'More actions for Mobile regression', exact: true});
  await trigger.click();
  const menu = page.getByRole('dialog', {name: 'More actions for Mobile regression', exact: true});
  await bounded(menu, 1024);
  await page.getByRole('searchbox', {name: 'Search projects'}).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('searchbox', {name: 'Search projects'})).toBeFocused();
});

test('empty management screens keep one set of useful actions', async ({page, request}) => {
  const response = await request.post('/api/projects', {data: {title: 'Empty mobile novel'}});
  expect(response.ok()).toBeTruthy();
  const {project} = await response.json();
  await page.goto(`/projects/${project.id}?tab=cast`);
  await expect(page.getByRole('button', {name: 'Add character', exact: true})).toHaveCount(1);
  await expect(page.getByRole('group', {name: 'Character filter'})).toBeHidden();
  await expect(page.getByRole('button', {name: 'Create images for all', exact: true})).toBeHidden();
  await expect(page.getByRole('button', {name: 'Generate from outline', exact: true})).toBeHidden();
  await page.screenshot({path: 'work/test-results/mobile-cast-empty-320.png'});
  await page.getByRole('combobox', {name: 'Workspace section', exact: true}).selectOption('lore');
  await expect(page.getByRole('button', {name: 'New lorebook', exact: true})).toHaveCount(1);
  await expect(page.getByRole('button', {name: 'Create a lorebook', exact: true})).toBeHidden();
  await page.getByRole('combobox', {name: 'Workspace section', exact: true}).selectOption('memory');
  await expect(page.locator('.memory-stats')).toBeHidden();
  await fits(page, 320);

  await page.locator('.workspace-menu > button').click();
  await page.locator('.workspace-submenu > summary').filter({hasText: 'Settings'}).click();
  await page.getByRole('button', {name: 'Novel settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: /^Novel settings/});
  await expect(settings.getByRole('combobox', {name: 'Novel settings section'})).toBeVisible();
  const title = await settings.getByRole('textbox', {name: 'Title', exact: true}).boundingBox();
  const suggest = await settings.locator('.with-action').first().locator('button').boundingBox();
  expect(suggest!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  await fits(page, 320);
  await page.screenshot({path: 'work/test-results/mobile-novel-settings-320.png'});
  await page.keyboard.press('Escape');
  await page.goto('/');
  await page.getByRole('button', {name: 'Dark', exact: true}).click();
  await page.getByRole('button', {name: 'New novel', exact: true}).click();
  await page.screenshot({path: 'work/test-results/mobile-new-novel-dark-320.png'});
});
