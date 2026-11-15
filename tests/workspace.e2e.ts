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
  provider=http.createServer((req,res)=>{if(req.url === '/v1/chat/completions') {res.setHeader('Content-Type','text/event-stream');res.end(`data: ${JSON.stringify({choices:[{delta:{content:'A painterly portrait in a storm-worn coat.'}}]})}\n\ndata: [DONE]\n\n`);return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:png}]}));});
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
    if(width<=720) expect(actionsBox!.y).toBeGreaterThanOrEqual(titleBox!.y+titleBox!.height);
    await expect.poll(async()=>page.locator('.portrait-chip img').evaluateAll(imgs=>imgs.every(img=>(img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth>0))).toBe(true);
    await page.screenshot({path:`work/test-results/workspace-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1280,height:900});await page.goto('/settings');await page.getByRole('button',{name:'Add connection',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Add connection'});await expect(modal).toBeVisible();
  await modal.getByRole('button',{name:'Save connection'}).focus();await page.keyboard.press('Tab');expect(await modal.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();
  await expect(page.getByRole('button',{name:'Add connection',exact:true})).toBeFocused();
  await page.goto('/');await expect(page.getByRole('heading',{name:'Your library',exact:true})).toBeVisible();await page.getByRole('button',{name:'Compact view'}).click();await expect(page.locator('.compact-library')).toBeVisible();
  await page.getByLabel('Search projects').fill('no matching novel');await expect(page.getByRole('heading',{name:'No novels match that search'})).toBeVisible();
  await page.getByLabel('Search projects').fill('');await page.getByRole('button',{name:'New novel',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Title',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'Writing style',exact:true})).toBeHidden();await page.keyboard.press('Escape');
  await page.goto(`/projects/${projectId}?tab=manuscript`);await page.evaluate(()=>{document.documentElement.style.zoom='2';});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'workspace fits at 200% CSS zoom').toBe(true);
});


test('workspace navigation returns to the same chapter and separates app settings', async ({page}) => {
  await page.goto(`/projects/${projectId}?tab=manuscript`);
  await expect(page.getByRole('heading', {name:'Chapter 1: After the storm',exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Novel settings',exact:true}).click();
  const settings = page.getByRole('dialog', {name:/Novel settings/});
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', {name:'App defaults & connections'})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('link', {name:'App settings',exact:true}).click();
  await page.getByRole('link', {name:'3. Return to novel'}).click();
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
  await page.getByRole('button',{name:'Show assistant',exact:true}).click();
  await expect(page.locator('.assistant-panel')).toBeVisible();
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
