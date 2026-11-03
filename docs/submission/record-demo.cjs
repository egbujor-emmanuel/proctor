'use strict';
// Records PROCTOR's submission demo from a running copy of the website.
//
//   node docs/submission/record-demo.cjs --rehearse   # check every selector first
//   node docs/submission/record-demo.cjs              # record docs/submission/proctor-demo.webm
//
// Environment: DEMO_BASE_URL (default http://localhost:4310, the static build
// served with `npx serve web/out -l 4310`), PLAYWRIGHT_CORE (path to a
// playwright-core install; default: the one bundled with @playwright/mcp).
//
// The on-chain scenes are not screenshots of an explorer: they render each
// transaction as read live from NEAR's archival RPC, including the registry's
// own sitting_resolved event.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_URL = process.env.DEMO_BASE_URL || 'http://localhost:4310';
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ||
  path.join(execSync('npm root -g').toString().trim(), '@playwright', 'mcp', 'node_modules', 'playwright-core');
const { chromium } = require(PLAYWRIGHT_CORE);

const OUT_DIR = __dirname;
const VIDEO_DIR = path.join(OUT_DIR, '.video-tmp');
const OUTPUT = path.join(OUT_DIR, 'proctor-demo.webm');
const REHEARSAL = process.argv.includes('--rehearse');
const ARCHIVAL_RPC = 'https://archival-rpc.testnet.fastnear.com';

/** The model-swap demo: [tx hash, sender, caption]. */
const SWAP = [
  ['9Jwx3jXp8We4a77VVBNv7qGLKpL48UC3zF8uf7CX9yT5', 'attrito.testnet', 'The demo agent sits the exam answering with Claude Sonnet 5.5: certified'],
  ['BrcXSNwX1qy7APxoTDNL5heFN22eB5FqoBT4teiQPUYX', 'proctor-sentinel.testnet', 'Its owner swaps the same URL to GPT-5.4 nano. A surprise re-test: suspended'],
  ['3SGvHzEY7c2Bo91eehtnapZbXE2eVk5mv4y1DDPWBLm4', 'proctor-sentinel.testnet', 'An hour later, another surprise re-test: revoked'],
];

const PALETTE = { paper: '#f4f1ea', raised: '#fbf9f4', ink: '#16140f', muted: '#57524a', rule: '#d4ccbb', seal: '#1f3a5f' };

// ---------- chain data ----------

async function rpc(method, params) {
  const res = await fetch(ARCHIVAL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'demo', method, params }),
  });
  const body = await res.json();
  if (!body.result) throw new Error(`${method} failed: ${JSON.stringify(body.error).slice(0, 200)}`);
  return body.result;
}

/** What the scene shows for one transaction, straight from the chain. */
async function readReceipt(hash, sender) {
  const tx = await rpc('tx', [hash, sender]);
  const call = tx.transaction.actions.find((a) => a.FunctionCall)?.FunctionCall;
  const block = await rpc('block', { block_id: tx.transaction_outcome.block_hash });
  const resolved = tx.receipts_outcome
    .filter((r) => r.outcome.executor_id === 'registry-v2.attrito.testnet')
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)))
    .find((e) => e.event === 'sitting_resolved');
  if (!resolved) throw new Error(`no sitting_resolved event in ${hash}`);
  const data = resolved.data[0];
  return {
    hash,
    signer: tx.transaction.signer_id,
    method: call?.method_name ?? '(none)',
    time: new Date(block.header.timestamp_nanosec / 1e6).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    candidate: data.candidate_model,
    outcome: data.outcome,
  };
}

// ---------- scenes rendered as pages ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function shell(inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;500&family=Newsreader:opsz,wght@6..72,400&display=swap" rel="stylesheet">
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: ${PALETTE.paper}; color: ${PALETTE.ink}; font-family: "IBM Plex Sans", sans-serif;
    background-image: repeating-linear-gradient(0deg, transparent 0 31px, rgb(212 204 187 / .35) 31px 32px); }
  .eyebrow { font-family: "IBM Plex Mono", monospace; font-size: 14px; letter-spacing: .18em; text-transform: uppercase; color: ${PALETTE.seal}; }
  h1 { font-family: "Newsreader", serif; font-weight: 400; font-size: 92px; margin: 12px 0 0; line-height: 1; }
  h2 { font-family: "Newsreader", serif; font-weight: 400; font-size: 40px; margin: 14px 0 0; }
  .card { background: ${PALETTE.raised}; border: 1px solid ${PALETTE.rule}; border-radius: 4px; padding: 28px 34px; width: 980px; box-shadow: 0 24px 50px -32px rgb(0 0 0 / .5); }
  .row { display: grid; grid-template-columns: 170px 1fr; gap: 10px; font-size: 18px; padding: 7px 0; border-bottom: 1px solid ${PALETTE.rule}; }
  .row b { font-family: "IBM Plex Mono", monospace; font-weight: 400; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; color: ${PALETTE.muted}; align-self: center; }
  .mono { font-family: "IBM Plex Mono", monospace; font-size: 16px; word-break: break-all; }
  .term { background: #16140f; color: #efe9dc; font-family: "IBM Plex Mono", monospace; font-size: 15px; line-height: 1.65; padding: 26px 30px; border-radius: 6px; width: 1120px; white-space: pre-wrap; }
  .term .pass { color: #6fcf9a; } .term .info { color: #e5b55c; }
</style></head><body>${inner}</body></html>`;
}

function titleScene() {
  return shell(`<div style="width:1000px"><p class="eyebrow">Built at NEAR HACKATHON · NEAR · OutLayer TEE · NEAR AI</p>
    <h1>PROCTOR</h1><h2>A driving test for AI agents.</h2></div>`);
}

function receiptScene(r, step) {
  const [name, value] = Object.entries(r.outcome)[0];
  const color = { Certified: '#1d6b45', Suspended: '#8a5a0c', Revoked: '#a3221b' }[name] ?? PALETTE.ink;
  return shell(`<div><p class="eyebrow">On NEAR testnet · step ${step} of 3 · read live from the archival RPC</p>
    <div class="card" style="margin-top:14px">
      <div class="row"><b>Transaction</b><span class="mono">${esc(r.hash)}</span></div>
      <div class="row"><b>Signed by</b><span class="mono">${esc(r.signer)}</span></div>
      <div class="row"><b>Called</b><span class="mono">registry-v2.attrito.testnet · ${esc(r.method)}</span></div>
      <div class="row"><b>When</b><span class="mono">${esc(r.time)}</span></div>
      <div class="row"><b>Candidate</b><span class="mono">${esc(r.candidate)}</span></div>
      <div class="row" style="border:0"><b>Registry event</b><span style="font-family:Newsreader,serif;font-size:44px;color:${color}">${esc(name)} · ${value.score_bps / 100}%</span></div>
    </div></div>`);
}

function verifierScene(text) {
  const lines = text
    .trimEnd()
    .split('\n')
    .map((l) => esc(l.length > 128 ? l.slice(0, 125) + '…' : l))
    .map((l) => l.replace(/^PASS/, '<span class="pass">PASS</span>').replace(/^info/, '<span class="info">info</span>'))
    .join('\n');
  return shell(`<div><p class="eyebrow">$ npm --prefix mcp run verify -- --tx 3SGvHzEY… --sender proctor-sentinel.testnet</p>
    <div class="term" style="margin-top:14px">${lines}</div></div>`);
}

function endScene() {
  return shell(`<div style="width:1000px"><p class="eyebrow">Try it in 5 minutes · no keys needed to read a certificate</p>
    <h1>PROCTOR</h1>
    <h2 class="mono" style="font-size:26px;margin-top:26px">github.com/egbujor-emmanuel/proctor</h2>
    <h2 class="mono" style="font-size:26px">registry-v2.attrito.testnet</h2>
    <p class="eyebrow" style="margin-top:34px">Built at NEAR HACKATHON</p></div>`);
}

// ---------- overlays and pacing (from the ui-demo skill) ----------

async function injectOverlays(page) {
  await page.evaluate((ink) => {
    if (!document.getElementById('demo-cursor')) {
      const cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      cursor.innerHTML =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      cursor.style.cssText = 'position:fixed;z-index:999999;pointer-events:none;width:24px;height:24px;left:-40px;top:-40px;transition:left .1s,top .1s;filter:drop-shadow(1px 1px 2px rgba(0,0,0,.3))';
      document.body.appendChild(cursor);
      document.addEventListener('mousemove', (e) => {
        cursor.style.left = e.clientX + 'px';
        cursor.style.top = e.clientY + 'px';
      });
    }
    if (!document.getElementById('demo-subtitle')) {
      const bar = document.createElement('div');
      bar.id = 'demo-subtitle';
      bar.style.cssText = `position:fixed;bottom:0;left:0;right:0;z-index:999998;text-align:center;padding:14px 24px;background:${ink}e6;color:#f4f1ea;font:500 19px "IBM Plex Sans","Segoe UI",sans-serif;letter-spacing:.2px;opacity:0;transition:opacity .3s;pointer-events:none`;
      document.body.appendChild(bar);
    }
  }, PALETTE.ink);
}

async function caption(page, text, hold = 0) {
  await page.evaluate((t) => {
    const bar = document.getElementById('demo-subtitle');
    if (!bar) return;
    bar.textContent = t;
    bar.style.opacity = t ? '1' : '0';
  }, text);
  await page.waitForTimeout(800 + hold);
}

async function smoothScrollTo(page, selector, offset = 70, wait = 1800) {
  await page.evaluate(
    ({ selector, offset }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no ${selector}`);
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' });
    },
    { selector, offset },
  );
  await page.waitForTimeout(wait);
}

async function moveAndClick(page, locator, label, postClickDelay = 900) {
  const el = locator.first();
  if (!(await el.isVisible().catch(() => false))) throw new Error(`"${label}" is not visible`);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await el.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
    await page.waitForTimeout(400);
  }
  await el.click();
  await page.waitForTimeout(postClickDelay);
}

async function showScene(page, html) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await injectOverlays(page);
}

async function openSite(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#registry');
  await page.evaluate(() => document.fonts.ready);
  await injectOverlays(page);
}

// ---------- rehearsal ----------

async function rehearse(page, receipts) {
  await openSite(page);
  const checks = [
    ['hero heading', '#hero-title'],
    ['how it works', '#how'],
    ['registry', '#registry'],
    ['certificate 0', '#cert-0-title'],
    ['certificate 1', '#cert-1-title'],
    ['proof section', '#proof'],
    ['check section', '#check'],
    ['DeepSeek chip', 'button:has-text("DeepSeek V4.1 Flash")'],
    ['demo agent chip', 'button:has-text("agent: demo-agent")'],
    ['trust model', '#trust'],
  ];
  let ok = true;
  for (const [label, selector] of checks) {
    const found = (await page.locator(selector).count()) > 0;
    console.log(`${found ? 'REHEARSAL OK  ' : 'REHEARSAL FAIL'}: ${label} (${selector})`);
    ok &&= found;
  }
  for (const r of receipts) console.log(`REHEARSAL OK  : ${r.hash.slice(0, 8)} ${r.method} -> ${Object.keys(r.outcome)[0]}`);
  if (!ok) throw new Error('rehearsal failed: fix selectors before recording');
  console.log('REHEARSAL PASSED');
}

// ---------- the recording ----------

async function record(page, receipts, verifyText) {
  await showScene(page, titleScene());
  await page.waitForTimeout(3500);

  await openSite(page);
  await caption(page, 'Public benchmarks leak into training data, and a certified agent can quietly swap models.', 2600);
  await caption(page, 'PROCTOR seals the exam in a hardware enclave and keeps re-testing the certificate.', 2600);

  await smoothScrollTo(page, '#how');
  await caption(page, 'The exam is an OutLayer secret, readable only by one pinned runner build, via the registry.', 2800);
  await page.mouse.wheel(0, 380);
  await page.waitForTimeout(900);
  await caption(page, 'Certificates are written only from OutLayer’s callback, after the contract re-checks the result.', 2800);

  await smoothScrollTo(page, '#registry');
  await caption(page, 'Read live from NEAR testnet: certificate 0 is active, certificate 1 is revoked.', 2600);
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(1600);

  for (const [i, r] of receipts.entries()) {
    await showScene(page, receiptScene(r, i + 1));
    await caption(page, SWAP[i][2], 3600);
  }

  await openSite(page);
  await smoothScrollTo(page, '#proof', 70, 1400);
  await caption(page, 'Every step of the swap demo, and the author payouts, are linked transactions.', 2600);

  await smoothScrollTo(page, '#check');
  await caption(page, 'A buyer checks before hiring: the same verdict the MCP server gives Claude Code.', 1600);
  await moveAndClick(page, page.locator('button:has-text("DeepSeek V4.1 Flash")'), 'DeepSeek chip', 3500);
  await caption(page, 'DeepSeek V4.1 Flash holds a live certificate with passed surprise re-tests: hire.', 2200);
  await moveAndClick(page, page.locator('button:has-text("agent: demo-agent")'), 'demo agent chip', 3500);
  await caption(page, 'The swapped demo agent was revoked after two failed re-tests: do not hire.', 2600);

  await showScene(page, verifierScene(verifyText));
  await caption(page, 'Anyone can verify a sitting from public data, down to NEAR AI’s signature on every answer.', 4200);

  await openSite(page);
  await smoothScrollTo(page, '#trust');
  await caption(page, 'What you don’t have to take on faith, and the limits, are stated in the README.', 3200);

  await showScene(page, endScene());
  await page.waitForTimeout(4000);
}

(async () => {
  const receipts = [];
  for (const [hash, sender] of SWAP) receipts.push(await readReceipt(hash, sender));
  const verifyText = fs.readFileSync(path.join(OUT_DIR, 'verify-3SGvHzEY.txt'), 'utf8');

  const browser = await chromium.launch({ headless: true });
  try {
    if (REHEARSAL) {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
      await rehearse(page, receipts);
      return;
    }
    fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
    });
    const page = await context.newPage();
    try {
      await record(page, receipts, verifyText);
    } finally {
      await context.close();
      fs.copyFileSync(await page.video().path(), OUTPUT);
      fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
      console.log('Video saved:', OUTPUT);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('DEMO ERROR:', e.message);
  process.exit(1);
});
