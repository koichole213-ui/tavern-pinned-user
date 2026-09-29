// Optional browser regression: requires Playwright and an installed Edge.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'pinned-user.js'), 'utf8');
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const width of [390, 1100]) {
            const page = await browser.newPage({ viewport: { width, height: 700 } });
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.route('https://selection.invalid/**', r => r.fulfill({ body: '<html><head></head><body></body></html>', contentType: 'text/html' }));
            await page.goto('https://selection.invalid');
            await page.evaluate(() => {
                window.records = new Map([['__migrated', '1']]);
                window.buttons = {};
                const ids = Array.from({ length: 60 }, (_, i) => String(i + 1).padStart(2, '0') + '.png');
                const jq = value => typeof value === 'function' ? value() : { val: () => '', on: (event, callback) => window.addEventListener(event, callback) };
                jq.fn = {}; window.$ = window.jQuery = jq;
                window.SillyTavern = { getContext: () => ({
                    accountStorage: { getState: () => Object.fromEntries(records), getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v) },
                    powerUserSettings: { personas: Object.fromEntries(ids.map(id => [id, 'User ' + id.slice(0, 2)])) },
                    getThumbnailUrl: () => 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
                }) };
                window.fetch = async () => ({ ok: true, json: async () => ids });
                window.appendInexistentScriptButtons = () => {};
                window.getButtonEvent = name => name;
                window.eventOn = (name, cb) => { buttons[name] = cb; };
            });
            await page.addScriptTag({ content: source });
            await page.evaluate(() => buttons['📌 常用 User']());
            const card = id => page.locator(`[data-persona-id="${id}.png"]`);
            await card('07').scrollIntoViewIfNeeded();
            await page.evaluate(() => { const list = document.querySelector('.hehe-pin-list'); window.before = { cards: [...list.children], top: list.scrollTop }; });
            await card('07').click();
            assert.equal(await page.evaluate(() => {
                const list = document.querySelector('.hehe-pin-list');
                return list.scrollTop === before.top && [...list.children].every((c, i) => c === before.cards[i]);
            }), true);
            await card('09').click();
            assert.equal(await card('07').locator('.hehe-pin-order').innerText(), '1');
            assert.equal(await card('09').locator('.hehe-pin-order').innerText(), '2');
            assert.equal(await page.evaluate(() => [...document.querySelector('.hehe-pin-list').children].every((c, i) => c === before.cards[i])), true);
            await card('07').click();
            assert.equal(await card('09').locator('.hehe-pin-order').innerText(), '1');
            await card('07').click();
            assert.equal(await card('07').locator('.hehe-pin-order').innerText(), '2');
            assert.equal(await page.evaluate(() => records.has('hehe_pinned_user_personas_v1')), false);
            await page.locator('.hehe-pin-search').fill('User 09');
            assert.equal(await page.locator('.hehe-pin-card').count(), 1);
            assert.equal(await card('09').locator('.hehe-pin-order').innerText(), '1');
            await page.locator('.hehe-pin-search').fill('');
            assert.equal(await page.locator('.hehe-pin-card').first().getAttribute('data-persona-id'), '01.png');
            await page.locator('.hehe-pin-save').click();
            assert.deepEqual(await page.evaluate(() => JSON.parse(records.get('hehe_pinned_user_personas_v1'))), ['09.png', '07.png']);
            await page.evaluate(() => buttons['📌 常用 User']());
            assert.equal(await page.locator('.hehe-pin-card').nth(0).getAttribute('data-persona-id'), '09.png');
            assert.equal(await page.locator('.hehe-pin-card').nth(1).getAttribute('data-persona-id'), '07.png');
            await card('40').scrollIntoViewIfNeeded();
            await page.evaluate(() => { const list = document.querySelector('.hehe-pin-list'); window.before = { cards: [...list.children], top: list.scrollTop }; });
            await page.locator('.hehe-pin-clear').click();
            assert.equal(await page.evaluate(() => {
                const list = document.querySelector('.hehe-pin-list');
                return list.scrollTop === before.top && [...list.children].every((c, i) => c === before.cards[i]);
            }), true);
            assert.equal(await page.locator('.hehe-pin-card.is-selected').count(), 0);
            assert.equal(await page.locator('.hehe-pin-count').innerText(), '已选 0 个');
            await page.locator('.hehe-pin-cancel').click();
            assert.deepEqual(await page.evaluate(() => JSON.parse(records.get('hehe_pinned_user_personas_v1'))), ['09.png', '07.png']);
            assert.deepEqual(errors, []);
            console.log(`PASS ${width}px: select 7/9, stable DOM/scroll, deselect numbering, search order, save/reopen, clear/cancel preserve data`);
            await page.close();
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
