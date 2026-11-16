import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let provider:http.Server;
let projectId:string;
let chapterId:string;
let castCharacterId:string;
let png='';

test.beforeAll(async ({request,browser}) => {
  const canvasPage = await browser.newPage();
  png = await canvasPage.evaluate(() => {const canvas=document.createElement('canvas');canvas.width=180;canvas.height=240;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#455b63';ctx.fillRect(0,0,180,240);ctx.fillStyle='#d5b69a';ctx.beginPath();ctx.ellipse(90,95,35,48,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#283943';ctx.fillRect(35,145,110,95);return canvas.toDataURL('image/png').split(',')[1]!;});
  await canvasPage.close();
  provider=http.createServer((req,res)=>{
    if(req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => {body += chunk;});
      req.on('end', () => {
        const {messages} = JSON.parse(body);
        const content = messages[0].content.includes('continuity archivist')
          ? JSON.stringify({summary:'The traveller reached the harbour.',facts:[],appearances:[]})
          : 'A painterly portrait in a storm-worn coat.';
        res.setHeader('Content-Type','text/event-stream');
        res.end(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`);
      });
      return;
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:png}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const post=async(url:string,data:unknown={})=>{const result=await request.post(`/api${url}`,{data});expect(result.ok(),await result.text()).toBeTruthy();return result.json();};
  const {project}=await post('/projects',{title:'The Glass Harbour',premise:'A salvage diver returns to a harbour full of secrets.'});projectId=project.id;
  const {revision}=await post(`/projects/${projectId}/outline/manual`);chapterId=revision.chapters[0].id;
  await request.put(`/api/projects/${projectId}/outline`,{data:{revisionId:revision.id,chapters:[{id:chapterId,title:'After the storm',brief:'Mara returns to shore.'},{id:`${projectId}-next`,title:'The signal',brief:'The lighthouse wakes.'}]}});
  await post(`/projects/${projectId}/outline/${revision.id}/approve`);
  await post(`/chapters/${chapterId}/append`,{text:'Mara stopped beneath the clock tower. Salt had dried along the sleeves of her coat. Across the water, a light turned in the abandoned lighthouse.'});
  const {character}=await post(`/projects/${projectId}/characters`,{name:'Mara Voss',role:'Protagonist',identity:'A salvage diver',appearance:'Dark hair, a navy coat.',keyCharacter:true});castCharacterId=character.id;
  await post(`/projects/${projectId}/characters`,{name:'Elias',role:'Harbour keeper'});
  const {connection:text}=await post('/connections',{name:'UI test text model',kind:'openai-compatible',baseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`});
  await request.put('/api/model-roles',{data:{scope:'project',projectId,assignments:[{role:'image_prompt',connectionId:text.id,model:'test'}]}});
  const {connection}=await post('/image-connections',{name:'UI test image service',kind:'openai-images',baseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,settings:{model:'test'}});
  const {job}=await post(`/characters/${character.id}/images`,{connectionId:connection.id,chapterId,prompt:'Mara in a navy coat.'});
  await expect.poll(async()=>{const r=await request.get(`/api/image-jobs/${job.id}`);return (await r.json()).job.status;}).toBe('completed');
  const gallery=await request.get(`/api/projects/${projectId}/images`);const {assets}=await gallery.json();
  await post(`/chapters/${chapterId}/selected-image`,{assetId:assets[0].id});
});
test.afterAll(async()=>{await new Promise<void>(resolve=>provider.close(()=>resolve()));});

test('compact cast filters, star toggles and stored appearance notes lead into a chapter timeline', async ({page, request}) => {
  const saved = await request.patch(`/api/chapters/${chapterId}/appearances/${castCharacterId}`, {data:{appearance:'Dark hair, a navy coat and a bandaged hand.'}});
  expect(saved.ok()).toBeTruthy();
  await page.goto(`/projects/${projectId}?tab=cast`);
  const mara = page.locator('.cast-card').filter({hasText:'Mara Voss'});
  const elias = page.locator('.cast-card').filter({hasText:'Elias'});
  await expect(mara.getByRole('button', {name:'Remove key character',exact:true})).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', {name:'★ Key characters',exact:true}).click();
  await expect(mara).toBeVisible();
  await expect(elias).toHaveCount(0);
  await page.getByRole('button', {name:'All characters',exact:true}).click();
  await expect(elias).toBeVisible();
  await mara.getByRole('button', {name:'Remove key character',exact:true}).click();
  await expect(mara.getByRole('button', {name:'Mark as key character',exact:true})).toHaveAttribute('aria-pressed', 'false');
  await mara.getByRole('button', {name:'Appearance notes',exact:true}).click();
  const notes = page.getByRole('dialog', {name:'Appearance notes — Mara Voss',exact:true});
  await expect(notes.getByText('Dark hair, a navy coat and a bandaged hand.', {exact:true})).toBeVisible();
  await expect(notes.getByRole('heading', {name:'Chapter 2: The signal',exact:true})).toBeVisible();
  await expect(notes.getByText('No appearance notes stored for this chapter.', {exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await mara.getByRole('button', {name:'Mark as key character',exact:true}).click();
  await expect(mara.getByRole('button', {name:'Remove key character',exact:true})).toBeEnabled();
  await mara.getByRole('button', {name:'Appearance timeline',exact:true}).click();
  const timeline = page.getByRole('region', {name:'Mara Voss appearance timeline',exact:true});
  await expect(timeline.locator('.timeline-chapter h3')).toHaveText(['Chapter 1: After the storm', 'Chapter 2: The signal']);
  await expect(timeline.locator('.timeline-image img')).toHaveCount(1);
  await expect(timeline.getByText('No image created for this chapter.', {exact:true})).toBeVisible();
  await timeline.getByRole('button', {name:'Show appearance notes',exact:true}).click();
  await expect(timeline.getByText('Dark hair, a navy coat and a bandaged hand.', {exact:true})).toBeVisible();
  await page.screenshot({path:'work/test-results/appearance-timeline.png',fullPage:true});
  await timeline.locator('.timeline-image button').click();
  const viewer = page.getByRole('dialog', {name:'Mara Voss — Timeline image',exact:true});
  await expect(viewer.locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  for (const width of [1440, 720, 320]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  }
  await page.getByRole('combobox', {name:'Workspace section',exact:true}).selectOption('cast');
  await expect(mara.getByText('Full profile', {exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await page.screenshot({path:'work/test-results/cast-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:900});
  expect((await mara.boundingBox())!.height).toBeLessThan(320);
  await page.screenshot({path:'work/test-results/cast-compact.png',fullPage:true});
  await mara.getByLabel('More actions for Mara Voss', {exact:true}).click();
  await expect(mara.getByRole('button', {name:'Manage portraits',exact:true})).toBeVisible();
  await mara.getByRole('button', {name:'Edit profile',exact:true}).click();
  await expect(page.getByRole('dialog', {name:'Edit character',exact:true}).getByRole('button', {name:'Key character',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('bulk memory rebuild includes late key characters and outdated appearance records', async ({page, request}) => {
  const post = async (url: string, data: unknown = {}) => {
    const response = await request.post(`/api${url}`, {data});
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const {project} = await post('/projects', {title:'Late key character', chapterCount:3});
  const {revision} = await post(`/projects/${project.id}/outline/manual`);
  const outline = await request.put(`/api/projects/${project.id}/outline`, {data:{revisionId:revision.id,chapters:[
    {id:revision.chapters[0].id,title:'Arrival',brief:'The traveller reaches the harbour.'},
    {id:`${project.id}-second`,title:'Departure',brief:'The traveller leaves the harbour.'},
    {id:`${project.id}-empty`,title:'Return',brief:'The traveller returns.'},
  ]}});
  expect(outline.ok()).toBeTruthy();
  await post(`/projects/${project.id}/outline/${revision.id}/approve`);
  const chaptersResponse = await request.get(`/api/projects/${project.id}/chapters`);
  const {chapters} = await chaptersResponse.json();
  const written = chapters.slice(0, 2) as Array<{id:string}>;
  for (const chapter of written) {
    const content = await request.put(`/api/chapters/${chapter.id}/content`, {data:{content:'A traveller reaches the harbour.'}});
    expect(content.ok()).toBeTruthy();
    const memory = await request.patch(`/api/chapters/${chapter.id}/memory`, {data:{summary:'The traveller reaches the harbour.'}});
    expect(memory.ok()).toBeTruthy();
  }
  const {character} = await post(`/projects/${project.id}/characters`, {name:'The traveller', appearance:'Dark hair and a navy coat.'});
  const {connection} = await post('/connections', {name:'Memory rebuild test',kind:'openai-compatible',baseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`});
  const roles = await request.put('/api/model-roles', {data:{scope:'project',projectId:project.id,assignments:[{role:'memory',connectionId:connection.id,model:'test'}]}});
  expect(roles.ok()).toBeTruthy();

  await page.goto(`/projects/${project.id}?tab=memory`);
  await expect(page.getByRole('button', {name:'Memory up to date',exact:true})).toBeDisabled();
  await page.getByRole('button', {name:'Characters',exact:true}).click();
  await page.locator('.cast-card').filter({hasText:'The traveller'}).getByRole('button', {name:'Mark as key character',exact:true}).click();
  await page.getByRole('button', {name:'Story memory',exact:true}).click();
  const rebuildTwo = page.getByRole('button', {name:'Rebuild 2 chapters',exact:true});
  await expect(rebuildTwo).toBeEnabled();
  const overview = await (await request.get(`/api/projects/${project.id}/memory`)).json();
  expect(overview.chapters.filter((chapter: {status:string}) => chapter.status === 'current')).toHaveLength(2);
  expect(overview.rebuildChapterIds).toEqual(written.map(chapter => chapter.id));
  await rebuildTwo.click();
  await expect(page.getByText('2 chapter refreshes are queued.', {exact:false})).toBeVisible();
  await expect(page.getByRole('button', {name:'Memory up to date',exact:true})).toBeDisabled();
  for (const chapter of written) {
    const portraits = await (await request.get(`/api/chapters/${chapter.id}/portraits`)).json();
    expect(portraits.appearances).toEqual([expect.objectContaining({characterId:character.id,status:'current'})]);
  }

  // Changing an earlier record outdates the next chapter's appearance without
  // changing either summary. The empty third chapter must stay out of the queue.
  await page.getByRole('button', {name:'Read story',exact:true}).click();
  const edit = await request.patch(`/api/chapters/${written[0].id}/appearances/${character.id}`, {data:{appearance:'Dark hair, a navy coat and a bandaged hand.'}});
  expect(edit.ok()).toBeTruthy();
  await page.getByRole('button', {name:'Story memory',exact:true}).click();
  const rebuildOne = page.getByRole('button', {name:'Rebuild 1 chapter',exact:true});
  await expect(rebuildOne).toBeEnabled();
  await rebuildOne.click();
  await expect(page.getByRole('button', {name:'Memory up to date',exact:true})).toBeDisabled();
  const repaired = await (await request.get(`/api/chapters/${written[1].id}/portraits`)).json();
  expect(repaired.appearances).toEqual([expect.objectContaining({status:'current',appearance:'Dark hair, a navy coat and a bandaged hand.'})]);
});

test('chapter images, viewer, studio, timeline and focus mode work with keyboard access',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  await expect(page.getByRole('heading',{name:'Chapter 1: After the storm',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Chapter images',exact:true}).click();
  const gallery=page.getByRole('dialog',{name:/Chapter images .*Chapter 1: After the storm/});
  await expect(gallery).toBeVisible();
  await gallery.getByRole('button',{name:'View image of Mara Voss'}).click();
  const viewer=page.getByRole('dialog',{name:/^Mara Voss .*Chapter 1: After the storm$/});await expect(viewer).toBeVisible();
  await page.keyboard.press('Escape');await expect(viewer).not.toBeVisible();await expect(gallery).toBeVisible();
  await gallery.getByRole('button',{name:'Generate images',exact:true}).click();await gallery.getByLabel('Select Mara Voss for generation').check();
  await expect(gallery.getByLabel('Select Elias for generation')).toHaveCount(0);
  await gallery.getByRole('button',{name:'Generate selected (1)'}).click();await page.getByRole('dialog',{name:'Confirm action'}).getByRole('button',{name:'Continue'}).click();
  await expect(gallery.getByText('completed: 1',{exact:true})).toBeVisible();
  await gallery.locator('.portrait-cast-row').filter({hasText:'Mara Voss'}).getByRole('button',{name:'Customize',exact:true}).click();
  const studio=page.getByRole('dialog',{name:'Portrait studio — Mara Voss'});await expect(studio).toBeVisible();
  await expect(studio.getByLabel('Chapter state (optional)')).toHaveValue(chapterId);
  await studio.getByLabel('Story moment').selectOption('start');await expect(studio.getByLabel('Story moment')).toHaveValue('start');
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Focus on story',exact:true}).click();await expect(page.locator('.chapter-sidebar')).toBeHidden();await expect(page.locator('.compact-portraits')).toBeHidden();
  await page.keyboard.press('Escape');await expect(page.locator('.compact-portraits')).toBeVisible();
  await page.getByRole('button',{name:'Characters',exact:true}).click();await page.locator('.cast-card').filter({hasText:'Mara Voss'}).getByRole('button',{name:'Appearance timeline'}).click();
  await expect(page.getByRole('heading',{name:'Images',exact:true})).toBeVisible();
  await expect(page.locator('.images-fields select').first()).toHaveValue(castCharacterId);
  await expect(page.getByRole('region', {name:'Mara Voss appearance timeline', exact:true})).toBeVisible();
  await page.getByRole('group', {name:'Image view'}).getByRole('button', {name:'Gallery',exact:true}).click();
  await page.locator('.images-fields select').first().selectOption('');
  await expect(page.locator('.image-card').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('populated layouts fit small screens and settings dialogs retain keyboard focus',async({page})=>{
  for(const width of [1440,1024,720,390,320]) {
    await page.setViewportSize({width,height:900});await page.goto(`/projects/${projectId}?tab=manuscript`);
    await expect(page.getByRole('heading',{name:'Chapter 1: After the storm',exact:true})).toBeVisible();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);expect(overflow,`workspace overflow at ${width}px`).toBe(false);
    await page.getByRole('button',{name:'Chapter images',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:/Chapter images .*Chapter 1: After the storm/});await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth),`image dialog at ${width}px`).toBe(true);
    await page.keyboard.press('Escape');
    const titleBox=await page.locator('.workspace-topbar-left').boundingBox();const actionsBox=await page.locator('.workspace-actions').boundingBox();
    if(width<=720) {
      await expect(page.getByRole('navigation', {name:'Workspace sections',exact:true})).toBeHidden();
      await expect(page.getByRole('combobox', {name:'Workspace section',exact:true})).toBeVisible();
      await expect(page.getByRole('combobox', {name:'Workspace section',exact:true})).toHaveValue('manuscript');
      expect(actionsBox!.y).toBeGreaterThanOrEqual(titleBox!.y);
      expect((await page.locator('.workspace-topbar').boundingBox())!.height).toBeLessThan(200);
    } else {
      await expect(page.getByRole('navigation', {name:'Workspace sections',exact:true})).toBeVisible();
      await expect(page.getByRole('combobox', {name:'Workspace section',exact:true})).toBeHidden();
    }
    await expect.poll(async()=>page.locator('.portrait-chip img').evaluateAll(imgs=>imgs.every(img=>(img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth>0))).toBe(true);
    await page.screenshot({path:`work/test-results/workspace-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1280,height:900});await page.goto('/settings');await page.getByRole('button',{name:'Add connection',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Add connection'});await expect(modal).toBeVisible();
  await modal.getByRole('button',{name:'Save connection'}).focus();await page.keyboard.press('Tab');expect(await modal.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();
  await expect(page.getByRole('button',{name:'Add connection',exact:true})).toBeFocused();
  await page.goto('/');await expect(page.getByRole('heading',{name:'Your library',exact:true})).toBeVisible();await expect(page.locator('.library-list')).toBeVisible();
  await page.getByLabel('Search projects').fill('no matching novel');await expect(page.getByRole('heading',{name:'No novels match that search'})).toBeVisible();
  await page.getByLabel('Search projects').fill('');await page.getByRole('button',{name:'New novel',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Story premise',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'Writing style',exact:true})).toBeHidden();await page.keyboard.press('Escape');
  await page.goto(`/projects/${projectId}?tab=manuscript`);await page.evaluate(()=>{document.documentElement.style.zoom='2';});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'workspace fits at 200% CSS zoom').toBe(true);
});


test('workspace navigation returns to the same chapter and separates app settings', async ({page}) => {
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  await expect(page.getByRole('heading', {name:'Chapter 1: After the storm',exact:true})).toBeVisible();
  await page.locator('.workspace-menu > summary').click();
  await page.locator('.workspace-submenu > summary').filter({hasText:'Settings'}).click();
  await page.getByRole('button', {name:'Novel settings',exact:true}).click();
  const settings = page.getByRole('dialog', {name:/Novel settings/});
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', {name:'App defaults & connections'})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.workspace-menu > summary').click();
  await page.getByRole('link', {name:'App settings',exact:true}).click();
  await page.getByRole('link', {name:'← Return to project',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Chapter 1: After the storm',exact:true})).toBeVisible();
  await page.getByRole('link', {name:'Library',exact:true}).click();
  await page.getByRole('link', {name:'Continue chapter 1: After the storm',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Chapter 1: After the storm',exact:true})).toBeVisible();
});


test('generated story opens in a wide reader with the assistant hidden', async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  await expect(page.getByRole('article', {name:'Story reader'})).toContainText('Mara stopped beneath the clock tower');
  await expect(page.getByRole('textbox', {name:'Chapter manuscript'})).toHaveCount(0);
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  expect((await page.locator('.manuscript-preview').boundingBox())!.width).toBeGreaterThan(800);
  await page.locator('.workspace-menu > summary').click();
  await page.locator('.workspace-submenu > summary').filter({hasText:'Workspace'}).click();
  await page.getByRole('button',{name:'Show assistant',exact:true}).click();
  await expect(page.locator('.assistant-panel')).toBeVisible();
  await page.locator('.workspace-menu > summary').click();
  await page.getByRole('button',{name:'Hide assistant',exact:true}).click();
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
});


test('refresh preserves the chosen workspace tab', async ({page}) => {
  await page.goto(`/projects/${projectId}?tab=outline`);
  await page.getByRole('button', {name: 'Images', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Images', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/tab=images/);
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Images', exact: true})).toBeVisible();
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', {name: 'Images', exact: true})).toBeVisible();
});

test('mobile reader hides and restores headers and navigates chapters in both reading modes', async ({page, request}) => {
  const post = async (url: string, data: unknown = {}) => {
    const response = await request.post(`/api${url}`, {data});
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const {project} = await post('/projects', {title:'Mobile reading'});
  const {revision} = await post(`/projects/${project.id}/outline/manual`);
  const firstId = revision.chapters[0].id;
  const outline = await request.put(`/api/projects/${project.id}/outline`, {data:{revisionId:revision.id,chapters:[
    {id:firstId,title:'A long walk',brief:'The traveller follows the coastline.'},
    {id:`${project.id}-second`,title:'Coming home',brief:'The traveller returns.'},
  ]}});
  expect(outline.ok()).toBeTruthy();
  await post(`/projects/${project.id}/outline/${revision.id}/approve`);
  const content = Array.from({length:70}, (_, i) => `The traveller walked along the shore, watching the waves roll in. This was mile ${i + 1}.`).join('\n\n');
  expect((await request.put(`/api/chapters/${firstId}/content`, {data:{content}})).ok()).toBeTruthy();
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/projects/${project.id}?tab=manuscript`);
  const shell = page.locator('.workspace-shell');
  const navigation = page.getByRole('navigation', {name:'Chapter navigation'});
  await expect(page.getByRole('article', {name:'Story reader'})).toContainText('This was mile 70');
  await expect(navigation.getByRole('button', {name:'Previous chapter',exact:true})).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(shell).toHaveClass(/reader-headers-hidden/);
  await expect.poll(async () => (await page.locator('.workspace-topbar').boundingBox())!.y + (await page.locator('.workspace-topbar').boundingBox())!.height).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await page.locator('.editor-header').boundingBox())!.y + (await page.locator('.editor-header').boundingBox())!.height).toBeLessThanOrEqual(1);
  await expect(navigation.getByRole('button', {name:'Next chapter',exact:true})).toBeInViewport();
  await page.screenshot({path:'work/test-results/mobile-reading-scrolled.png'});
  await page.evaluate(() => window.scrollBy(0, -100));
  await expect(shell).not.toHaveClass(/reader-headers-hidden/);
  await expect.poll(async () => Math.round((await page.locator('.workspace-topbar').boundingBox())!.y)).toBe(0);
  await expect.poll(async () => (await page.locator('.editor-header').boundingBox())!.y).toBeGreaterThan(0);
  await navigation.getByRole('button', {name:'Next chapter',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Chapter 2: Coming home',exact:true})).toBeVisible();
  await expect(navigation.getByRole('button', {name:'Next chapter',exact:true})).toBeDisabled();
  await navigation.getByRole('button', {name:'Focus on story',exact:true}).click();
  await expect(shell).toHaveClass(/focus-mode/);
  await expect(page.getByRole('combobox', {name:'Workspace section',exact:true})).toBeHidden();
  await navigation.getByRole('button', {name:'Previous chapter',exact:true}).click();
  await expect(page.getByRole('article', {name:'Story reader'})).toContainText('This was mile 70');
  await expect(shell).toHaveClass(/focus-mode/);
  await expect(navigation.getByRole('button', {name:'Previous chapter',exact:true})).toBeDisabled();
  await navigation.getByRole('button', {name:'Next chapter',exact:true}).click();
  await expect(page.getByRole('article', {name:'Story reader'})).toContainText('Your story will appear here');
  await navigation.getByRole('button', {name:'Exit focus',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Chapter 2: Coming home',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox', {name:'Workspace section',exact:true})).toHaveValue('manuscript');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
});

test('mobile images open directly, fit the screen and swipe between images', async ({page, request}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  await page.locator('.portrait-chip').filter({hasText:'Mara Voss'}).click();
  const viewer = page.locator('.modal-image-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const imageBox = await viewer.locator('.image-viewer-stage img').boundingBox();
  expect(imageBox!.height).toBeGreaterThan(500);
  await page.screenshot({path:'work/test-results/mobile-image-viewer.png'});
  await expect(viewer.getByRole('button', {name:'Delete image',exact:true})).toBeHidden();
  await expect(viewer.getByRole('slider', {name:'Image zoom'})).toBeHidden();
  await viewer.getByText('More', {exact:true}).click();
  await expect(viewer.getByRole('button', {name:'Delete image',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
  await page.getByRole('combobox', {name:'Workspace section',exact:true}).selectOption('images');
  await expect(page.getByText('Create images', {exact:true})).toBeVisible();
  await expect(page.getByRole('button', {name:'Create images for all chapters',exact:true})).toBeHidden();

  // Supply a second image for a deterministic swipe check without generating it.
  const response = await request.get(`/api/projects/${projectId}/images`);
  const {assets} = await response.json();
  await page.route(`**/api/projects/${projectId}/images`, route => route.fulfill({json:{assets:[assets[0], {...assets[0],id:'swipe-second',url:`${assets[0].url}?second=1`}]}}));
  await page.reload();
  await expect(page.getByRole('combobox', {name:'Workspace section',exact:true})).toHaveValue('images');
  await page.locator('.image-open').first().click();
  await expect(viewer.getByText('1 / 2', {exact:true})).toBeVisible();
  await viewer.locator('.image-viewer-stage').evaluate(element => {
    element.dispatchEvent(new TouchEvent('touchstart', {bubbles:true,touches:[new Touch({identifier:1,target:element,clientX:300,clientY:300})]}));
    element.dispatchEvent(new TouchEvent('touchend', {bubbles:true,changedTouches:[new Touch({identifier:1,target:element,clientX:100,clientY:310})]}));
  });
  await expect(viewer.getByText('2 / 2', {exact:true})).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(viewer.getByText('1 / 2', {exact:true})).toBeVisible();
});

test('outline keeps scrolling after nested image dialogs unmount and repeated tab switches', async ({page, request}) => {
  const response = await request.post('/api/projects', {data:{title:'Long mobile outline',chapterCount:25}});
  const {project} = await response.json();
  const manual = await request.post(`/api/projects/${project.id}/outline/manual`);
  const {revision} = await manual.json();
  const savedOutline = await request.put(`/api/projects/${project.id}/outline`, {data:{revisionId:revision.id,chapters:Array.from({length:25}, (_, i) => ({
    id:i === 0 ? revision.chapters[0].id : `${project.id}-${i}`,
    title:`Journey ${i + 1}`,brief:'The traveller follows the shore and meets someone new. '.repeat(5),
  }))}});
  expect(savedOutline.ok()).toBeTruthy();
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  await page.getByRole('button', {name:'Chapter images',exact:true}).click();
  const gallery = page.getByRole('dialog', {name:/Chapter images .*Chapter 1: After the storm/});
  await gallery.getByRole('button', {name:'View image of Mara Voss'}).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(2);
  // A route change unmounts both dialog layers in the same React commit.
  await page.getByRole('link', {name:'Library',exact:true}).evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
  await page.locator('.project-card-main').filter({has:page.getByRole('heading', {name:'Long mobile outline',exact:true})}).click();
  const lastBrief = page.getByRole('textbox', {name:'Chapter 25 brief',exact:true});
  for (let i = 0; i < 3; i++) {
    await expect(lastBrief).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(lastBrief).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('combobox', {name:'Workspace section',exact:true}).selectOption('manuscript');
    await page.getByRole('combobox', {name:'Workspace section',exact:true}).selectOption('outline');
  }
});
