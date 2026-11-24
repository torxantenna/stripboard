// End-to-end smoke test: `npm run build && npx vite preview --port 4173` then `node e2e/smoke.cjs`.
// Loads every example, waits for the optimiser to produce a verified layout, screenshots both
// board sides, drags a part and checks the metrics update, then repeats on perfboard with
// traces + jumpers and with point-to-point wiring.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.APP_URL || 'http://localhost:4173/';
const OUT = process.env.SHOT_DIR || path.join(__dirname, '..', 'screenshots');
const SCALE = Number(process.env.SCALE || 1);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: SCALE });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);

  const ids = await page.$$eval('select[aria-label="Load example"] option', (os) => os.map((o) => o.value).filter(Boolean));
  let failures = 0;
  for (const id of ids) {
    const prevRun = Number((await page.getAttribute('.progress', 'data-run').catch(() => '0')) || 0);
    await page.selectOption('select[aria-label="Load example"]', id);
    const t0 = Date.now();
    try {
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector('.progress');
          return el && Number(el.getAttribute('data-run')) > prev && el.getAttribute('data-done') === 'yes';
        },
        prevRun,
        { timeout: 120000 },
      );
    } catch (e) {
      console.log(`${id}: optimiser did not finish`);
      failures++;
      continue;
    }
    const status = await page.textContent('[data-testid=verify-status]');
    const metrics = await page.$$eval('table.metrics tr', (rows) => rows.map((r) => r.textContent).join(' | '));
    console.log(`${id}: ${status} in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${metrics}`);
    if (!status.includes('Verified')) failures++;
    await page.screenshot({ path: path.join(OUT, `${id}-component.png`), fullPage: true });
    await page.click('text=Copper side');
    await page.locator('svg.board').screenshot({ path: path.join(OUT, `${id}-copper.png`) });
    await page.click('text=Component side');
  }

  // Exact solver (clingo-wasm) in the browser.
  const aspCase = async (example, model, limit, expect) => {
    const prevRun = Number((await page.getAttribute('.progress', 'data-run').catch(() => '0')) || 0);
    await page.selectOption('select[aria-label="Load example"]', example);
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('.progress');
        return el && Number(el.getAttribute('data-run')) > prev && el.getAttribute('data-done') === 'yes';
      },
      prevRun,
      { timeout: 120000 },
    );
    await page.selectOption('.asp select >> nth=0', model);
    await page.fill('.asp input[type=number]', String(limit));
    const t0 = Date.now();
    await page.click('.asp button.primary');
    await page.waitForSelector('[data-testid=asp-result]', { timeout: (limit + 60) * 1000 });
    const badge = (await page.textContent('[data-testid=asp-result] .badge')).trim();
    const detail = (await page.textContent('[data-testid=asp-result]')).replace(badge, '').trim();
    const table = await page.$$eval('table.compare tbody tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent).join(' ')).join(' | '));
    const ok = badge.includes(expect);
    console.log(`clingo ${example}/${model}: ${badge} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${ok ? '' : `EXPECTED "${expect}" `}— ${detail.slice(0, 160)}\n   ${table}`);
    if (!ok) failures++;
    await page.screenshot({ path: path.join(OUT, `clingo-${example}-${model}.png`), fullPage: true });
  };
  await aspCase('555', 'paper', 5, 'Not expressible');
  await aspCase('astable', 'paper', 20, 'Unsatisfiable');
  await aspCase('555', 'relaxed', 6, 'Time limit');
  // Full model: clingo chooses parts, cuts and links; the board must still verify.
  for (const [ex, limit, expect] of [['led', 10, 'Proven optimal'], ['555', 15, '']]) {
    await aspCase(ex, 'full', limit, expect);
    const v = await page.textContent('[data-testid=verify-status]');
    const own = await page.isVisible('text=Cuts and links chosen by clingo');
    console.log(`   full/${ex}: board ${v.trim()}, clingo's own cuts/links shown: ${own}`);
    if (!v.includes('Verified') || !own) failures++;
  }

  // Manual drag: move the first part a few holes and check the cost changes.
  const before = await page.$$eval('table.metrics tr', (rows) => rows.map((r) => r.textContent).join('|'));
  const part = page.locator('g.part').first();
  const box = await part.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  const after = await page.$$eval('table.metrics tr', (rows) => rows.map((r) => r.textContent).join('|'));
  const selected = await page.textContent('.statusbar');
  console.log(`drag: metrics ${before === after ? 'UNCHANGED' : 'changed'}; status bar: ${selected.trim()}`);
  if (before === after) failures++;
  await page.screenshot({ path: path.join(OUT, `after-drag.png`), fullPage: true });

  // Perfboard: traces + straight jumpers (default options), then point-to-point wiring.
  const runIdNow = async () => Number((await page.getAttribute('.progress', 'data-run').catch(() => '0')) || 0);
  const waitDone = (prev) =>
    page.waitForFunction(
      (p) => {
        const el = document.querySelector('.progress');
        return el && Number(el.getAttribute('data-run')) > p && el.getAttribute('data-done') === 'yes';
      },
      prev,
      { timeout: 180000 },
    );
  const perfCase = async (example, label) => {
    const prev = await runIdNow();
    const t0 = Date.now();
    if (example) await page.selectOption('select[aria-label="Load example"]', example);
    else await page.click('button:has-text("Optimise")');
    await waitDone(prev);
    const status = await page.textContent('[data-testid=verify-status]');
    const metrics = await page.$$eval('table.metrics tr', (rows) => rows.map((r) => r.textContent).join(' | '));
    const sheet = await page.textContent('.sheet summary');
    const asp = await page.isVisible('.asp');
    console.log(`perfboard ${label}: ${status} in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${metrics} — ${sheet.trim()}${asp ? ' (ASP panel VISIBLE)' : ''}`);
    if (!status.includes('Verified') || asp || /cuts/.test(sheet)) failures++;
    const name = `perfboard-${label.replace(/\W+/g, '-')}`;
    await page.screenshot({ path: path.join(OUT, `${name}-component.png`), fullPage: true });
    await page.click('text=Copper side');
    await page.locator('svg.board').screenshot({ path: path.join(OUT, `${name}-copper.png`) });
    await page.click('text=Component side');
  };
  await page.click('[aria-label="Board type"] button:has-text("Perfboard")');
  // (555 is already loaded, and re-selecting it would not start a run.)
  for (const ex of ['lm386', '555']) await perfCase(ex, `${ex} traces+jumpers`);
  await page.selectOption('label:has-text("Jumper wires") select', 'angled');
  await perfCase(null, '555 traces+angled');
  await page.uncheck('label:has-text("Solder-side traces") input');
  await perfCase(null, '555 point-to-point');
  await page.check('label:has-text("Solder-side traces") input');
  await page.selectOption('label:has-text("Jumper wires") select', 'straight');
  await page.click('[aria-label="Board type"] button:has-text("Stripboard")');

  // Phone width: no horizontal page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`mobile horizontal overflow: ${overflow}px`);
  if (overflow > 0) failures++;
  await page.screenshot({ path: path.join(OUT, `mobile.png`) });

  if (errors.length) {
    console.log('page errors:\n  ' + errors.join('\n  '));
    failures++;
  }
  await browser.close();
  console.log(failures ? `FAILED (${failures})` : 'ALL OK');
  process.exit(failures ? 1 : 0);
})();
