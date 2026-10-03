const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'loader.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'pinned-user.module.js'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:20px;background:#212126;color:#eee;font-family:Arial,sans-serif;--SmartThemeQuoteColor:#d7ad63;--SmartThemeBlurTintColor:#242429;--SmartThemeBodyColor:#eee;--SmartThemeBorderColor:#888}
#user_avatar_block{display:flex;gap:12px}.avatar-container{padding:20px;border:1px solid #555}
</style></head><body><div id="persona-management-button"><button class="drawer-icon">User 人设</button><div class="drawer-content"><input id="persona_search_bar"><select id="persona_sort_order"><option>A-Z</option></select><div id="persona_pagination_container"></div><div id="user_avatar_block"></div></div></div></body></html>`;
async function setup(page, {late = false, local = ['p.png','hidden.png']} = {}) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (!process.env.PINNED_LIVE) await page.route(`https://cdn.jsdelivr.net/gh/koichole213-ui/tavern-pinned-user@v${version}/pinned-user.module.js`, route => route.fulfill({body:runtime,contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'}}));
    await page.route('https://fixture.invalid/**', route => route.fulfill({body:html,contentType:'text/html'}));
    await page.goto('https://fixture.invalid/');
    await page.evaluate(({late, local}) => {
        window.fixture = {buttons:{}, page:1, requests:0, errors:[], account:new Map(), accountWrites:0, late, nativeReady:!late};
        const f = window.fixture;
        localStorage.setItem('hehe_pinned_user_personas_v1', JSON.stringify(local));
        f.account.set('__migrated', '1');
        const jq = function(value) {
            if (typeof value === 'function') {void value(); return;}
            const nodes = typeof value === 'string' ? [...document.querySelectorAll(value)] : [value];
            const wrapped = Object.create(jq.fn); wrapped.nodes = nodes; wrapped.length = nodes.length;
            return wrapped;
        };
        jq.fn = {
            is(selector) {return this.nodes.some(node => node.matches?.(selector));},
            val() {return this.nodes[0]?.value;},
            on(name, callback) {this.nodes.forEach(node=>node.addEventListener(name, callback)); return this;},
            trigger(name) {if(f.nativeReady) void f.nativeRender(); return this;},
        };
        jq._data = () => ({input:f.nativeReady ? [() => {}] : []});
        window.$ = window.jQuery = jq;
        f.installPager = () => {jq.fn.pagination = function(arg, pageNumber) {
            if (typeof arg === 'object') {f.options = arg; f.page = arg.pageNumber || 1;}
            else if (arg === 'go') f.page = pageNumber;
            const ids = f.options.dataSource.slice((f.page-1)*2, f.page*2);
            const list = document.querySelector('#user_avatar_block');
            list.replaceChildren(...ids.map(id => {const card=document.createElement('div');card.className='avatar-container';card.dataset.avatarId=id;card.textContent=id;return card;}));
            return this;
        };};
        f.nativeRender = async () => {
            f.requests++;
            await Promise.resolve();
            const entities = ['a.png','b.png','p.png','z.png'];
            jq('#persona_pagination_container').pagination({dataSource:entities,pageNumber:f.page});
            f.nativeEntities = entities;
            // 与酒馆一样，用同一份数组计算当前 User 的位置。
            f.navigate = id => jq('#persona_pagination_container').pagination('go',Math.floor(entities.indexOf(id)/2)+1);
        };
        if (!late) f.installPager();
        window.SillyTavern = {getContext: () => ({
            accountStorage: {getState:()=>Object.fromEntries(f.account), getItem:k=>f.account.get(k)??null, setItem:(k,v)=>{f.accountWrites++;f.account.set(k,v);}},
            powerUserSettings:{personas:{'a.png':'普通 User','b.png':'另一个 User','p.png':'常用 User','hidden.png':'基本信息：隐藏旧数据'},persona_descriptions:{}},
            getThumbnailUrl:()=>'data:image/png;base64,broken',getRequestHeaders:()=>({}),
        })};
        window.fetch = async () => ({ok:true,json:async()=>['a.png','b.png','p.png','hidden.png']});
        window.getPersonaAvatarPath = () => 'data:image/png;base64,also-broken';
        f.scriptButtons=[{name:'📌 常用 User',visible:true},{name:'🔄 检查更新',visible:true},{name:'custom',visible:false}];
        window.getScriptButtons=()=>f.scriptButtons;
        window.replaceScriptButtons=buttons=>{f.scriptButtons=buttons;};
        window.appendInexistentScriptButtons = () => {};
        window.getButtonEvent = name => name;
        window.eventOn = (name, cb) => {f.buttons[name]=cb; return {stop(){delete f.buttons[name];}};};
        window.toastr = Object.fromEntries(['info','success','warning','error'].map(type=>[type,msg=>{f.lastToast={type,msg};}]));
    }, {late,local});
    await page.addScriptTag({content:source,type:'module'});
    return errors;
}
(async () => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    try {
        const page = await browser.newPage({viewport:{width:1100,height:850}});
        const errors = await setup(page);
        await page.waitForFunction(() => document.querySelector('#user_avatar_block')?.firstElementChild?.dataset.avatarId === 'p.png');
        assert.deepEqual(await page.evaluate(()=>fixture.scriptButtons.map(b=>b.name)), ['📌 常用 User','custom']);
        await page.evaluate(() => window.fixture.navigate('a.png'));
        assert.equal(await page.evaluate(() => fixture.page), 1);
        await page.evaluate(() => $('#persona_pagination_container').pagination('go',2));
        await page.waitForTimeout(1700);
        assert.equal(await page.evaluate(() => fixture.page), 2);
        console.log('PASS browser: startup pinning, native navigation and manual paging');
        const before = await page.evaluate(() => fixture.accountWrites);
        await page.evaluate(() => fixture.buttons['📌 常用 User']());
        assert.match(await page.locator('.hehe-pin-subtitle').innerText(), /TA们/);
        await page.waitForFunction(() => document.querySelector('[data-persona-id="p.png"] img')?.style.visibility === 'hidden');
        assert.equal(await page.locator('[data-persona-id="p.png"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.evaluate(() => fixture.accountWrites), before);
        await page.screenshot({path:path.resolve('work/desktop.png')});
        await page.setViewportSize({width:390,height:844});
        await page.screenshot({path:path.resolve('work/mobile.png')});
        assert.equal(await page.evaluate(() => document.querySelector('.hehe-pin-dialog').getBoundingClientRect().width <= innerWidth), true);
        await page.locator('.hehe-pin-save').click();
        await page.waitForFunction(() => fixture.account.has('hehe_pinned_user_personas_v1'));
        assert.deepEqual(await page.evaluate(() => JSON.parse(fixture.account.get('hehe_pinned_user_personas_v1'))), ['p.png','hidden.png']);
        console.log('PASS browser: broken avatars retain selection; filtered records survive saving; desktop/mobile fit');
        await page.waitForTimeout(1700);
        await page.evaluate(() => {
            $('#persona_pagination_container').pagination('go',2);
            const list = document.querySelector('#user_avatar_block');
            window.originalCards = [...list.children];
            const drawer = document.querySelector('#persona-management-button .drawer-content');
            const icon = document.querySelector('#persona-management-button .drawer-icon');
            icon.addEventListener('click', () => drawer.classList.toggle('openDrawer'));
            drawer.classList.add('openDrawer');
        });
        const requests = await page.evaluate(() => fixture.requests);
        for (let i=0;i<3;i++) {
            await page.locator('#persona-management-button .drawer-icon').click();
            await page.locator('#persona-management-button .drawer-icon').click();
        }
        await page.waitForTimeout(3100);
        assert.equal(await page.evaluate(() => fixture.page), 2);
        assert.equal(await page.evaluate(() => fixture.requests), requests);
        assert.equal(await page.evaluate(() => [...document.querySelector('#user_avatar_block').children].every((card,i)=>card===originalCards[i])), true);
        console.log('PASS browser: repeated close/reopen preserves page and DOM, no refresh request');
        await page.evaluate(() => fixture.buttons['📌 常用 User']());
        await page.locator('.hehe-pin-save').click();
        await page.waitForFunction(() => fixture.page === 1);
        console.log('PASS browser: saving pins still returns to page one');
        await page.evaluate(() => window.__hehePinnedUserPersonas.destroy());
        await page.waitForFunction(() => document.querySelector('#user_avatar_block')?.firstElementChild?.dataset.avatarId === 'a.png');
        assert.equal(await page.locator('.hehe-persona-pin-badge').count(), 0);
        assert.deepEqual(await page.evaluate(() => JSON.parse(fixture.account.get('hehe_pinned_user_personas_v1'))), ['p.png','hidden.png']);
        await page.addScriptTag({content:source,type:'module'});
        await page.waitForFunction(() => document.querySelector('#user_avatar_block')?.firstElementChild?.dataset.avatarId === 'p.png');
        console.log('PASS browser: disable restores native order without page reload; re-enable restores pins and retains records');
        assert.deepEqual(errors, []);
        const latePage = await browser.newPage();
        const lateErrors = await setup(latePage, {late:true,local:[]});
        await latePage.waitForTimeout(10500);
        await latePage.evaluate(() => {fixture.nativeReady=true;fixture.installPager();fixture.account.set('hehe_pinned_user_personas_v1','["p.png"]');});
        await latePage.waitForFunction(() => document.querySelector('#user_avatar_block')?.firstElementChild?.dataset.avatarId === 'p.png');
        assert.deepEqual(lateErrors, []);
        console.log('PASS browser: delayed plugin and account data after 10 seconds recover without reload');
    } finally {await browser.close();}
})().catch(e => {console.error(e);process.exitCode=1;});
