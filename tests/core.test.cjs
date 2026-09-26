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
    const jq = () => ({ on() {}, val: () => search });
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
    const injected = src.replace('    $(initialise);', `    globalThis.api = {readPinned, writePinned, reorderPersonas, patchPersonaPagination, maintain, destroy, compareVersions, validateUpdate, replaceOwnScript, checkForUpdate};`);
    vm.runInNewContext(injected, sandbox);
    return {api: sandbox.api, jq, host, context, local, storage, sandbox,
        setSearch: value => {search = value;}, counts: () => ({fetches, updates})};
}
test('release metadata and source versions agree', () => {
    new vm.Script(src);
    assert.equal(pkg.content, src);
    assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
    boot().api.validateUpdate(pkg);
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
test('version comparison is numeric and rejects malformed values', () => {
    const {api} = boot();
    assert.equal(api.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(api.compareVersions('1.1.0', '1.1.0'), 0);
    assert.equal(api.compareVersions('1.0.5', '1.1.0'), -1);
    assert.throws(() => api.compareVersions('v1.1', '1.1.0'));
});
test('update only changes matching nested script and retains identity, data, switches and buttons', () => {
    const {api} = boot();
    const old = { ...pkg, id: 'installed', enabled: false, data: {mySetting: 42}, button: {enabled:false, buttons:[{name:'custom',visible:false}]} };
    const other = {...pkg, id: 'unrelated'};
    const trees = [{type:'folder', id:'folder', scripts:[old, other]}];
    const next = api.replaceOwnScript(trees, 'installed', {...pkg, content:'new source'});
    const updated = next[0].scripts[0];
    assert.equal(updated.id, old.id);
    assert.equal(updated.enabled, false);
    assert.equal(updated.data, old.data);
    assert.equal(updated.button.enabled, false);
    assert.deepEqual(updated.button.buttons[0], old.button.buttons[0]);
    assert.equal(next[0].scripts[1], other);
    assert.equal(old.content, pkg.content);
    assert.throws(() => api.replaceOwnScript(trees, 'missing', pkg));
    assert.throws(() => api.replaceOwnScript([old, old], 'installed', pkg));
});
test('invalid identity or mismatched version is rejected before update', () => {
    const {api} = boot();
    assert.throws(() => api.validateUpdate({...pkg, id:'other'}));
    assert.throws(() => api.validateUpdate({...pkg, version:'1.2.0'}));
    assert.throws(() => api.validateUpdate({...pkg, content: pkg.content + '\n syntax error {'}));
});
test('equal or older versions cause no write', async () => {
    const h = boot();
    await h.api.checkForUpdate();
    assert.deepEqual(h.counts(), {fetches:1, updates:0});
    const older = {...pkg, version:'1.0.9', content: pkg.content.replace("const SCRIPT_VERSION = '1.1.0';", "const SCRIPT_VERSION = '1.0.9';")};
    h.host.fetch = async () => ({ok:true, text:async () => JSON.stringify(older)});
    await h.api.checkForUpdate();
    assert.equal(h.counts().updates, 0);
});
test('network error, non-JSON, cancellation and destroyed instance cause no write', async () => {
    const h = boot();
    h.host.fetch = async () => {throw new Error('offline');};
    await h.api.checkForUpdate();
    h.host.fetch = async () => ({ok:true,text:async () => '<html>error</html>'});
    await h.api.checkForUpdate();
    const newer = {...pkg, version:'1.1.1', content: pkg.content.replace("const SCRIPT_VERSION = '1.1.0';", "const SCRIPT_VERSION = '1.1.1';")};
    h.host.fetch = async () => ({ok:true,text:async () => JSON.stringify(newer)});
    h.host.confirm = () => false;
    await h.api.checkForUpdate();
    assert.equal(h.counts().updates, 0);
    h.host.confirm = () => true;
    await h.api.checkForUpdate();
    assert.equal(h.counts().updates, 1);
    h.api.destroy();
    await h.api.checkForUpdate();
    assert.equal(h.counts().updates, 1);
});
