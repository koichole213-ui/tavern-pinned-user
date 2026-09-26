const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'pinned-user.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'pinned-user.json'), 'utf8'));
const key = 'hehe_pinned_user_personas_v1';
const plain = x => JSON.parse(JSON.stringify(x));
function boot(localIds = []) {
    const local = new Map([[key, JSON.stringify(localIds)]]);
    const storage = map => ({ getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), getState: () => Object.fromEntries(map) });
    const context = {};
    let search = '', fetches = 0, updates = 0;
    const jq = () => ({ on() {}, val: () => search, trigger: () => {host.onNativeInput?.();} });
    jq.fn = {};
    const document = {querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, removeEventListener() {}};
    const host = {document, jQuery: jq, localStorage: storage(local),
        SillyTavern: { getContext: () => context }, requestAnimationFrame() {},
        setTimeout, clearTimeout, clearInterval, AbortController, confirm: () => true,
        fetch: async () => {fetches++; return {ok: true, text: async () => JSON.stringify(pkg)};},
    };
    host.parent = host;
    const sandbox = {window: host, $: jq, console, URL, setTimeout,
        getScriptId: () => 'installed-id',
        updateScriptTreesWith: updater => {updates++; return updater([{...pkg, id: 'installed-id'}]);},
    };
    const injected = src.replace('    $(initialise);', `    globalThis.api = {readPinned, writePinned, reorderPersonas, patchPersonaPagination, maintain, destroy};`);
    vm.runInNewContext(injected, sandbox);
    return {api: sandbox.api, jq, host, context, local, storage, sandbox,
        setSearch: value => {search = value;}, counts: () => ({fetches, updates})};
}
test('release metadata and source versions agree', () => {
    new vm.Script(src);
    assert.match(pkg.content, /const VERSION =/);
    assert.ok(!pkg.content.includes("updateScriptTreesWith"));
    assert.equal(pkg.button.buttons.length, 1);
    assert.ok(src.includes("勾选后，TA们"));
    assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);

});
test('late account data supersedes empty and stale local records', () => {
    for (const ids of [[], ['old.png']]) {
        const h = boot(ids);
        assert.deepEqual(plain(h.api.readPinned()), ids);
        h.context.accountStorage = h.storage(new Map([['__migrated','1'], [key, '["new.png"]']]));
        assert.deepEqual(plain(h.api.readPinned()), ['new.png']);
        assert.equal(h.local.get(key), '["new.png"]');
    }
});
test('startup does not write local records over uninitialised account storage', () => {
    const h = boot(['old.png']), account = new Map();
    h.context.accountStorage = h.storage(account);
    h.api.readPinned();
    assert.equal(account.size, 0);
    account.set('__migrated', '1'); account.set(key, '[]');
    assert.deepEqual(plain(h.api.readPinned()), []);
});
test('explicit save before account readiness is kept and eventually saved', () => {
    const h = boot();
    h.api.writePinned(['chosen.png']);
    const account = new Map([['__migrated','1'], [key,'["old.png"]']]);
    h.context.accountStorage = h.storage(account);
    assert.deepEqual(plain(h.api.readPinned()), ['chosen.png']);
    assert.equal(account.get(key), '["chosen.png"]');
});
test('late pagination plugin can be hooked after the first readiness check', () => {
    const h = boot(); h.api.maintain();
    const native = function() {};
    h.jq.fn.pagination = native;
    h.api.maintain();
    assert.notEqual(h.jq.fn.pagination, native);
    h.api.destroy();
    assert.equal(h.jq.fn.pagination, native);
    assert.equal(h.counts().fetches, 0);
});
test('sorting keeps native navigation array consistent and preserves other item order', async () => {
    const h = boot(['p2', 'p1']);
    let rendered;
    h.jq.fn.pagination = options => { rendered = options.dataSource; };
    h.api.patchPersonaPagination();
    const original = ['a', 'p1', 'b', 'p2'];
    h.jq.fn.pagination.call({is: () => true}, {dataSource: original});
    assert.deepEqual(original, ['p2', 'p1', 'a', 'b']);
    assert.equal(rendered, original);
    await Promise.resolve();
});
test('search order and other pagers remain unchanged', () => {
    const h = boot(['p']);
    h.jq.fn.pagination = () => {};
    h.api.patchPersonaPagination();
    h.setSearch('query');
    const search = ['a', 'p'];
    h.jq.fn.pagination.call({is: () => true}, {dataSource: search});
    assert.deepEqual(search, ['a', 'p']);
    h.setSearch('');
    const other = ['a', 'p'];
    h.jq.fn.pagination.call({is: () => false}, {dataSource: other});
    assert.deepEqual(other, ['a', 'p']);
});
test('disable restores native pagination before refreshing once, preserving pin storage', () => {
    const h = boot(['p.png']);
    let calls = 0;
    const native = function() {};
    h.jq.fn.pagination = native;
    h.jq._data = () => ({ input: [() => {}] });
    h.host.document.querySelector = () => ({});
    h.host.onNativeInput = () => {
        calls++;
        assert.equal(h.jq.fn.pagination, native);
        assert.equal(h.local.get(key), '["p.png"]');
    };
    h.api.patchPersonaPagination();
    h.api.destroy();
    h.api.destroy();
    assert.equal(calls, 1);
});
test('instance handoff skips redundant native refresh', () => {
    const h = boot();
    let calls = 0;
    h.jq.fn.pagination = function() {};
    h.jq._data = () => ({ input: [() => {}] });
    h.host.document.querySelector = () => ({});
    h.host.onNativeInput = () => {calls++;};
    h.api.patchPersonaPagination();
    h.api.destroy({refreshNative:false});
    assert.equal(calls, 0);
});
