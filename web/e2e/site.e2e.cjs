'use strict';
// End-to-end check of the PROCTOR website: every section, control and link.
//
//   SITE_URL=https://proctor.attrito.workers.dev node web/e2e/site.e2e.cjs
//   SITE_URL=http://localhost:4310 node web/e2e/site.e2e.cjs
//
// Expected live state is read from the registry itself (not hard-coded), so a
// certificate that changes status between runs is a pass, not a failure.
// Exits 1 if any check fails. PLAYWRIGHT_CORE and CHROMIUM_PATH as in
// docs/submission/record-demo.cjs.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SITE = (process.env.SITE_URL || 'https://proctor.attrito.workers.dev').replace(/\/$/, '');
const RPC = 'https://rpc.testnet.near.org';
const REGISTRY = 'registry-v2.attrito.testnet';
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ||
  path.join(execSync('npm root -g').toString().trim(), '@playwright', 'mcp', 'node_modules', 'playwright-core');
const { chromium } = require(PLAYWRIGHT_CORE);

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), '.cache'), 'ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  for (const build of fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      if (fs.existsSync(path.join(root, build, exe))) return path.join(root, build, exe);
    }
  }
  return undefined;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function view(method, args = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: REGISTRY, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } });
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = attempt % 2 ? 'https://rpc.testnet.fastnear.com' : RPC;
    try {
      const json = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20000) })).json();
      if (json.result?.result) return JSON.parse(Buffer.from(json.result.result).toString());
      last = JSON.stringify(json.error ?? json).slice(0, 120);
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`${method} failed: ${last}`);
}

const stateOf = (status) => (typeof status === 'string' ? status : Object.keys(status)[0]).toLowerCase();

async function linkStatus(request, url) {
  // One more try after a dropped connection: a reset is the network, not the link.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await request.get(url, { timeout: 30000, maxRedirects: 5 });
      return res.status();
    } catch (e) {
      if (attempt === 2) return `error: ${e.message.split('\n')[0].slice(0, 60)}`;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function verdictAfterClick(page, label) {
  await page.locator(`#check button:has-text("${label}")`).click();
  // The snapshot answer is labelled "confirming on chain"; wait for the live one.
  const card = page.locator('#check [aria-label="Verdict"]');
  await card.waitFor({ timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector('#check')?.innerText.includes('confirming on chain'), null, { timeout: 45000 }).catch(() => {});
  return (await card.innerText()).replace(/\s+/g, ' ');
}

(async () => {
  const certs = await view('list_certificates', { from_index: 0, limit: 100 });
  const config = await view('get_config');
  const byModel = Object.fromEntries(certs.map((c) => [c.candidate_model, c]));

  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const consoleErrors = [];
  // The site races its reads across several RPC nodes and keeps the first
  // answer, so a node that loses (or fails) the race is not an error.
  const RPC_NODES = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
  const fromRpcRace = (m) => RPC_NODES.some((u) => (m.location().url || '').startsWith(u) || m.text().includes(`fetch at '${u}`));
  // The page never calls the sentinel on load; the only sentinel request is this suite's own refused re-test.
  const fromRetestCheck = (m) => (m.location().url || '').startsWith('https://proctor-sentinel.attrito.workers.dev/retest');
  page.on('console', (m) => m.type() === 'error' && !fromRpcRace(m) && !fromRetestCheck(m) && consoleErrors.push(m.text().slice(0, 140)));
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 140)));

  // ---- load ----
  const res = await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  check('page loads', res.status() === 200, `HTTP ${res.status()}`);
  check('title', (await page.title()).startsWith('PROCTOR'), await page.title());
  check('one h1', (await page.locator('h1').count()) === 1);
  const snapshotFirst = await page.locator('text=reading the live chain').first().isVisible().catch(() => false);
  check('first paint shows data (snapshot or live)', (await page.locator('[id^=cert-][id$=-title]').count()) > 0);
  await page.waitForFunction(() => !document.body.innerText.includes('reading the live chain'), null, { timeout: 60000 }).catch(() => {});
  const live = !(await page.locator('text=reading the live chain').first().isVisible().catch(() => false));
  check('live chain read replaces the snapshot', live, snapshotFirst ? 'snapshot shown first' : 'live at first look');

  // ---- hero ----
  const sittingsText = await page.locator('#top dl > div').nth(1).locator('.sr-only, [aria-label]').first().textContent().catch(() => '');
  check('hero stat: active certificates label', (await page.locator(`#top dt:has-text("Active certificates (of ${certs.length})")`).count()) === 1);
  void sittingsText;
  const statRow = await page.locator('#top dl').innerText();
  check('hero stats present', /open exams/i.test(statRow) && /sittings/i.test(statRow), statRow.replace(/\s+/g, ' ').slice(0, 80));
  for (const [cta, target] of [['Check an agent', '#check'], ['Test it in 5 minutes', '#test-it']]) {
    const href = await page.locator(`#top a:has-text("${cta}")`).getAttribute('href');
    check(`hero CTA "${cta}" points to ${target}`, href === target, href);
  }
  const stageButtons = page.locator('[aria-label="Show a stage of the certificate lifecycle"] button');
  const stages = await stageButtons.count();
  const notes = new Set();
  for (let i = 0; i < stages; i++) {
    await stageButtons.nth(i).click();
    await page.waitForTimeout(700);
    notes.add((await page.locator('#scope-caption').innerText()).trim());
  }
  check('hero lifecycle buttons change the figure', stages >= 3 && notes.size === stages, `${stages} buttons, ${notes.size} distinct captions`);
  check('hero figure labelled as an illustration', /illustration/i.test(await page.locator('#scope-caption').innerText()));
  const pause = page.locator('button:has-text("Pause"), button:has-text("Play")').first();
  await pause.click();
  check('marquee pause toggles', (await pause.getAttribute('aria-pressed')) === 'true');
  await pause.click();

  // ---- header nav ----
  for (const [label, id] of [['Test it', 'test-it'], ['How it works', 'how'], ['Index', 'index'], ['Registry', 'registry'], ['Check an agent', 'check'], ['Trust model', 'trust'], ['Verify', 'verify']]) {
    await page.locator(`header nav a:has-text("${label}")`).first().click();
    await page.waitForTimeout(2200);
    const top = await page.locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().top);
    check(`nav "${label}" scrolls to #${id}`, top > -5 && top < 160, `top=${Math.round(top)}`);
  }
  const runnerHref = await page.locator('header a:has-text("Runner build")').getAttribute('href');
  check('header "Runner build" link', runnerHref?.includes('proctor-runner/releases'), runnerHref);

  // ---- PROCTOR Index: one row per candidate and exam, latest certificate ----
  const pairs = new Map();
  for (const c of certs) {
    const key = `${c.candidate_model}|${c.exam_id}`;
    if (!pairs.has(key) || c.cert_id > pairs.get(key).cert_id) pairs.set(key, c);
  }
  const indexRows = page.locator('#index tbody tr');
  check('Index has one row per candidate and exam', (await indexRows.count()) === pairs.size, `${await indexRows.count()} rows, ${pairs.size} expected`);
  const indexText = (await page.locator('#index').innerText()).replace(/\s+/g, ' ');
  const missing = [...pairs.values()].filter((c) => !indexText.includes(c.candidate_model));
  check('Index lists every certified candidate', missing.length === 0, missing.map((c) => c.candidate_model).join(', ') || `${pairs.size} candidates`);
  check('Index states how many hold a live certificate', new RegExp(`\\d+ of ${pairs.size} holding a live certificate`).test(indexText), indexText.match(/\d+ of \d+ holding[^·]*/)?.[0]);

  // ---- order a surprise re-test: on every live or suspended certificate, never on a revoked one ----
  const papers = page.locator('#registry article');
  const paperCount = await papers.count();
  let withButton = 0, wrong = [];
  for (let i = 0; i < paperCount; i++) {
    const paper = papers.nth(i);
    const revoked = (await paper.innerText()).includes('REVOKED');
    const has = (await paper.locator('button:has-text("Order a surprise re-test")').count()) === 1;
    if (has) withButton++;
    if (has === revoked) wrong.push(i);
  }
  check('re-test button on live certificates only', wrong.length === 0 && withButton > 0, `${withButton} of ${paperCount} papers have it${wrong.length ? `; wrong on ${wrong.join(',')}` : ''}`);
  // The same cross-origin POST the button sends, for a revoked certificate: the sentinel refuses it and pays nothing.
  const refusal = await page.evaluate(async () => {
    try {
      const r = await fetch('https://proctor-sentinel.attrito.workers.dev/retest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cert_id: 1 }) });
      return `${r.status} ${(await r.json()).error}`;
    } catch (e) { return String(e); }
  });
  check('the page can order a re-test (a revoked one is refused, unpaid)', refusal === '409 revoked', refusal);

  // ---- verify: the live checks pass against the real chain, and every claim is listed ----
  await page.locator('#verify').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => /\d+ of \d+ passed/.test(document.querySelector('#verify')?.innerText || ''), null, { timeout: 60000 }).catch(() => {});
  const verifyText = (await page.locator('#verify').innerText()).replace(/\s+/g, ' ');
  const tally = verifyText.match(/(\d+) of (\d+) passed/);
  check('verify: every live check passes against the chain', tally && tally[1] === tally[2] && tally[2] === '5', tally ? tally[0] : 'no result');
  const claimRows = await page.locator('#verify tbody tr').count();
  check('verify: each claim with its test', claimRows >= 9, `${claimRows} claims`);

  // ---- test it: copy buttons copy the exact command ----
  const commands = page.locator('#test-it pre code');
  // By aria-label: the visible text changes to "Copied" after a click, which
  // would drop the button out of a text match and shift every later index.
  const copyButtons = page.locator('#test-it button[aria-label^="Copy:"]');
  const nCmd = await commands.count();
  let copied = 0;
  for (let i = 0; i < Math.min(nCmd, await copyButtons.count()); i++) {
    // Let the smooth scroll settle first, or the click lands on whatever moved under the cursor.
    await copyButtons.nth(i).scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await copyButtons.nth(i).click();
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    if (clip === (await commands.nth(i).innerText())) copied++;
  }
  check('test-it copy buttons copy their command', nCmd > 0 && copied === nCmd, `${copied}/${nCmd}`);
  const step1 = await commands.first().innerText();
  check('test-it step 1 asks about a model the registry certifies now', /is_certified/.test(step1) && byModel['anthropic/claude-sonnet-5-5'] && stateOf(byModel['anthropic/claude-sonnet-5-5'].status) === 'active', step1.slice(0, 90));

  // ---- registry ----
  for (const c of certs) {
    const title = page.locator(`#cert-${c.cert_id}-title`);
    const article = page.locator(`article:has(#cert-${c.cert_id}-title)`);
    const shown = await title.count();
    const text = shown ? (await article.innerText()).toLowerCase() : '';
    const want = stateOf(c.status);
    check(`certificate ${c.cert_id} shows status "${want}"`, shown && text.includes(want === 'active' ? 'active' : want), c.candidate_model);
  }
  check('runner line names the live runner', (await page.locator('#registry').innerText()).includes('Grading with runner'));
  if (config.pending_runner) check('runner line mentions the pending change', (await page.locator('#registry').innerText()).includes('proposed'));

  // ---- check tool ----
  const expect = (model) => {
    const c = byModel[model];
    if (!c) return 'No certificate';
    return stateOf(c.status) === 'active' ? 'Hire' : 'Do not hire';
  };
  for (const [label, model] of [
    ['Claude Sonnet 5.5', 'anthropic/claude-sonnet-5-5'],
    ['DeepSeek V4.1 Flash', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'],
    ['GPT-5.4 nano', 'openai/gpt-5.4-nano'],
    ['agent: demo-agent', 'agent:attrito.testnet/demo-agent'],
  ]) {
    const v = await verdictAfterClick(page, label).catch((e) => `error ${e.message.slice(0, 60)}`);
    const want = expect(model);
    check(`check "${label}" says "${want}"`, v.includes(`Verdict ${want}`) || v.startsWith(`VERDICT ${want}`) || v.includes(want), v.slice(0, 110));
  }
  const input = page.locator('#candidate');
  await input.fill('bad id!');
  await page.locator('#check button[type=submit]').click();
  await page.waitForTimeout(500);
  check('invalid id shows an error and clears the old verdict', (await page.locator('#candidate-error').innerText()).length > 0 && (await page.locator('#check [aria-label="Verdict"]').count()) === 0);
  await input.fill('');
  await page.locator('#check button[type=submit]').click();
  await page.waitForTimeout(500);
  check('empty submit asks for an id', (await page.locator('#candidate-error').innerText()).length > 0);
  await page.locator('#check label:has-text("Agent endpoint")').click();
  await input.fill('attrito.testnet/demo-agent');
  await page.locator('#check button[type=submit]').click();
  const typed = await page.locator('#check [aria-label="Verdict"]').innerText({ timeout: 45000 }).catch(() => '');
  check('typed agent id checks', typed.includes('attrito.testnet/demo-agent'), typed.replace(/\s+/g, ' ').slice(0, 80));

  // ---- trust: MCP config copy ----
  const mcpCopy = page.locator('#trust button[aria-label^="Copy:"]');
  await mcpCopy.click();
  await page.waitForTimeout(300);
  const mcpClip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check('MCP config copies valid JSON', (() => { try { return Boolean(JSON.parse(mcpClip).mcpServers.proctor); } catch { return false; } })());

  // ---- every external link ----
  const hrefs = [...new Set(await page.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => a.href)))];
  const bad = [];
  for (const href of hrefs) {
    // GitHub rate-limits bursts: pace its links, and back off when it says 429.
    if (href.includes('github.com')) await new Promise((r) => setTimeout(r, 1500));
    let status = await linkStatus(context.request, href);
    for (let wait = 20000; status === 429 && wait <= 80000; wait *= 2) {
      await new Promise((r) => setTimeout(r, wait));
      status = await linkStatus(context.request, href);
    }
    if (status !== 200) bad.push(`${status} ${href}`);
  }
  check(`external links return 200 (${hrefs.length} checked)`, bad.length === 0, bad.length ? `${bad.length} not 200: ${bad.slice(0, 4).join(' | ')}` : '');
  const blankWithoutRel = await page.locator('a[target=_blank]:not([rel*=noopener])').count();
  check('new-tab links carry rel=noopener', blankWithoutRel === 0);

  // ---- console ----
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // ---- phone width and keyboard ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await phone.newPage();
  await mp.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await mp.waitForTimeout(3000);
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal scroll at 390 px', overflow <= 0, `overflow ${overflow}px`);
  await mp.keyboard.press('Tab');
  const skip = await mp.evaluate(() => document.activeElement?.textContent?.trim());
  check('first Tab reaches the skip link', skip === 'Skip to content', skip);
  const outline = await mp.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none' || document.activeElement.matches(':focus-visible'));
  check('focus is visible', outline);
  await phone.close();

  const reduced = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const rp = await reduced.newPage();
  await rp.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await rp.waitForTimeout(2500);
  check('reduced motion: content visible', (await rp.locator('[id^=cert-][id$=-title]').count()) > 0 && (await rp.locator('#hero-title').isVisible()));
  await reduced.close();

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${SITE}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E ERROR:', e.message);
  process.exit(2);
});
