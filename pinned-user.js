/**
 * 常用 User 置顶
 *
 * 用途：在 SillyTavern 原生 Persona 管理页中，把勾选的人设排到第一页最前面。
 * 运行环境：酒馆助手（JS-Slash-Runner）全局脚本。
 *
 * 脚本不会修改、复制或删除人设，只保存一份由头像文件名组成的置顶顺序。
 */

(() => {
    'use strict';

    const SCRIPT_NAME = '常用 User 置顶';
    const SCRIPT_VERSION = '1.1.0';
    const SCRIPT_ID = '3e38034d-7bc2-489e-9e8c-32296e609f79';
    const UPDATE_BUTTON = '🔄 检查更新';
    const UPDATE_URL = 'https://raw.githubusercontent.com/koichole213-ui/tavern-pinned-user/main/pinned-user.json';
    const BUTTON_NAME = '📌 常用 User';
    const STORAGE_KEY = 'hehe_pinned_user_personas_v1';
    const INSTANCE_KEY = '__hehePinnedUserPersonas';
    const STYLE_ID = 'hehe-pinned-user-personas-style';
    const MODAL_ID = 'hehe-pinned-user-personas-modal';

    const hostWindow = window.parent && window.parent !== window ? window.parent : window;
    const hostDocument = hostWindow.document;
    let host$ = hostWindow.jQuery || hostWindow.$;
    const instanceToken = Symbol(SCRIPT_NAME);

    let originalPagination = null;
    let wrappedPagination = null;
    let personaListObserver = null;
    let decorateQueued = false;
    let pinnedCache = null;
    let personaPaginationRevision = 0;
    let firstPageRequested = false;
    let maintenanceTimer = null;
    let observedList = null;
    let lastUiReady = false;
    let lastPinnedSignature = null;
    let refreshPromise = null;
    let refreshAgain = false;
    let pendingPinned = null;
    let managerGeneration = 0;
    let updateBusy = false;
    let updateController = null;
    const buttonStops = [];
    const personaPaginationWaiters = new Set();
    let isDestroyed = false;

    function getContext() {
        const api = typeof SillyTavern !== 'undefined' ? SillyTavern : hostWindow.SillyTavern;
        return typeof api?.getContext === 'function' ? api.getContext() : api;
    }

    function normalisePinnedIds(value) {
        return Array.isArray(value)
            ? value.filter((id, index) => typeof id === 'string' && id && value.indexOf(id) === index)
            : [];
    }

    function readPinnedFrom(storage) {
        if (!storage) return null;
        try {
            const rawValue = storage.getItem(STORAGE_KEY);
            if (rawValue === null) return null;
            return normalisePinnedIds(JSON.parse(rawValue));
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 读取一份置顶存储失败。`, error);
            return null;
        }
    }

    function getLocalStorage() {
        try { return hostWindow.localStorage; } catch { return null; }
    }

    function getAccountStorage() {
        const storage = getContext()?.accountStorage;
        // SillyTavern 在初始化完成时写入此标记；初始化前不能拿本地旧值覆盖账号。
        if (storage?.getState && !Object.hasOwn(storage.getState(), '__migrated')) return null;
        return storage;
    }

    function saveTo(storage, ids) {
        if (!storage) return false;
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(ids));
            return true;
        } catch {
            console.warn(`[${SCRIPT_NAME}] 置顶记录未能写入一份存储。`);
            return false;
        }
    }

    function readPinned() {
        const account = getAccountStorage();
        if (pendingPinned !== null) {
            if (saveTo(account, pendingPinned)) pendingPinned = null;
            return [...pinnedCache];
        }
        const accountPinned = readPinnedFrom(account);
        const localPinned = readPinnedFrom(getLocalStorage());
        pinnedCache = accountPinned ?? localPinned ?? pinnedCache ?? [];
        // 只镜像已读到的账号记录，不在启动时把本地旧值回写账号。
        if (accountPinned !== null && JSON.stringify(accountPinned) !== JSON.stringify(localPinned)) {
            saveTo(getLocalStorage(), accountPinned);
        }
        return [...pinnedCache];
    }

    function writePinned(ids) {
        pinnedCache = normalisePinnedIds(ids);
        const accountSaved = saveTo(getAccountStorage(), pinnedCache);
        const localSaved = saveTo(getLocalStorage(), pinnedCache);
        pendingPinned = accountSaved ? null : [...pinnedCache];
        return { accountSaved, localSaved };
    }

    function reorderPersonas(items) {
        const pinned = readPinned();
        if (!pinned.length || !Array.isArray(items)) return items;

        const order = new Map(pinned.map((id, index) => [id, index]));
        const pinnedItems = [];
        const otherItems = [];

        for (const item of items) {
            (order.has(item) ? pinnedItems : otherItems).push(item);
        }

        pinnedItems.sort((a, b) => order.get(a) - order.get(b));
        return [...pinnedItems, ...otherItems];
    }

    function patchPersonaPagination() {
        if (isDestroyed || !host$?.fn?.pagination || wrappedPagination) return false;

        originalPagination = host$.fn.pagination;
        wrappedPagination = function (...args) {
            const options = args[0];
            const isPersonaPager = this.is?.('#persona_pagination_container');
            const isInitialisation = options && typeof options === 'object' && Array.isArray(options.dataSource);
            const searchIsActive = String(host$('#persona_search_bar').val() || '').trim().length > 0;

            if (isPersonaPager && isInitialisation && !searchIsActive) {
                const reordered = reorderPersonas(options.dataSource);
                // 酒馆后续还通过原数组计算当前 User 的页码，必须保持两边顺序一致。
                reordered.forEach((id, index) => { options.dataSource[index] = id; });
                args[0] = { ...options, dataSource: options.dataSource };
            }

            const result = originalPagination.apply(this, args);

            if (isPersonaPager && isInitialisation) {
                const pager = this;
                // 酒馆会在 pagination() 返回后继续跳转到当前 Persona 所在页，
                // 所以把“回第一页”和完成信号放到当前调用栈结束之后。
                Promise.resolve().then(() => {
                    if (isDestroyed) return;

                    if (!searchIsActive && readPinned().length && firstPageRequested) {
                        try {
                            pager.pagination('go', 1);
                            firstPageRequested = false;
                        } catch (error) {
                            console.debug(`[${SCRIPT_NAME}] Persona 分页完成后回到第一页失败。`, error);
                        }
                    }

                    personaPaginationRevision += 1;
                    for (const waiter of [...personaPaginationWaiters]) {
                        if (personaPaginationRevision <= waiter.afterRevision) continue;
                        personaPaginationWaiters.delete(waiter);
                        hostWindow.clearTimeout(waiter.timer);
                        waiter.resolve(true);
                    }
                    queueDecorateCards();
                });
            }

            return result;
        };

        Object.assign(wrappedPagination, originalPagination);
        host$.fn.pagination = wrappedPagination;
        return true;
    }

    function restorePersonaPagination() {
        if (originalPagination && host$?.fn?.pagination === wrappedPagination) {
            host$.fn.pagination = originalPagination;
        }
        originalPagination = null;
        wrappedPagination = null;
    }

    function waitForPersonaPagination(afterRevision, timeoutMs) {
        if (personaPaginationRevision > afterRevision) return Promise.resolve(true);

        return new Promise(resolve => {
            const waiter = {
                afterRevision,
                resolve,
                timer: null,
            };
            waiter.timer = hostWindow.setTimeout(() => {
                personaPaginationWaiters.delete(waiter);
                resolve(false);
            }, timeoutMs);
            personaPaginationWaiters.add(waiter);
        });
    }

    function queueDecorateCards() {
        if (decorateQueued || isDestroyed) return;
        decorateQueued = true;
        hostWindow.requestAnimationFrame(() => {
            decorateQueued = false;
            decorateCards();
        });
    }

    function reorderVisibleCards() {
        const searchIsActive = String(host$('#persona_search_bar').val() || '').trim().length > 0;
        const list = hostDocument.querySelector('#user_avatar_block');
        const pinned = readPinned();
        if (!list || !pinned.length || searchIsActive) return;

        const cards = Array.from(list.children)
            .filter(element => element.matches?.('.avatar-container[data-avatar-id]'));
        if (cards.length < 2) return;

        const order = new Map(pinned.map((id, index) => [id, index]));
        const originalOrder = new Map(cards.map((card, index) => [card, index]));
        const desiredCards = [...cards].sort((a, b) => {
            const aOrder = order.get(a.getAttribute('data-avatar-id'));
            const bOrder = order.get(b.getAttribute('data-avatar-id'));
            if (aOrder !== undefined || bOrder !== undefined) {
                if (aOrder === undefined) return 1;
                if (bOrder === undefined) return -1;
                return aOrder - bOrder;
            }
            return originalOrder.get(a) - originalOrder.get(b);
        });

        const orderChanged = desiredCards.some((card, index) => card !== cards[index]);
        if (orderChanged) list.append(...desiredCards);
    }

    function decorateCards() {
        if (isDestroyed || !host$) return;
        reorderVisibleCards();
        const pinned = new Set(readPinned());
        hostDocument.querySelectorAll('#user_avatar_block .avatar-container[data-avatar-id]').forEach(card => {
            const avatarId = card.getAttribute('data-avatar-id');
            const shouldPin = pinned.has(avatarId);
            const oldBadge = card.querySelector(':scope > .hehe-persona-pin-badge');

            card.classList.toggle('hehe-persona-is-pinned', shouldPin);
            if (shouldPin && !oldBadge) {
                const badge = hostDocument.createElement('span');
                badge.className = 'hehe-persona-pin-badge fa-solid fa-thumbtack';
                badge.title = '常用 User · 已置顶';
                badge.setAttribute('aria-label', '已置顶');
                card.prepend(badge);
            } else if (!shouldPin && oldBadge) {
                oldBadge.remove();
            }
        });
    }

    function watchPersonaList() {
        const list = hostDocument.querySelector('#user_avatar_block');
        if (list === observedList) return;
        personaListObserver?.disconnect();
        personaListObserver = null;
        observedList = list;
        if (!list) return;
        personaListObserver = new hostWindow.MutationObserver(queueDecorateCards);
        personaListObserver.observe(list, { childList: true });
        queueDecorateCards();
    }

    function installStyles() {
        hostDocument.getElementById(STYLE_ID)?.remove();
        const style = hostDocument.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #user_avatar_block .avatar-container.hehe-persona-is-pinned {
                position: relative;
                border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #d7ad63) 74%, transparent) !important;
            }

            .hehe-persona-pin-badge {
                position: absolute;
                z-index: 3;
                top: 7px;
                left: 7px;
                display: grid;
                width: 24px;
                height: 24px;
                place-items: center;
                border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #d7ad63) 70%, transparent);
                border-radius: 999px;
                color: var(--SmartThemeQuoteColor, #efc373);
                background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #171717) 88%, transparent);
                box-shadow: 0 5px 14px rgba(0, 0, 0, .25);
                font-size: 12px;
                pointer-events: none;
            }

            #${MODAL_ID} {
                position: fixed;
                z-index: 100001;
                inset: 0;
                display: grid;
                place-items: center;
                box-sizing: border-box;
                width: 100vw;
                height: 100vh;
                height: 100dvh;
                overflow: hidden;
                padding: max(14px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom));
                color: var(--SmartThemeBodyColor, #ece7df);
                background: rgba(5, 7, 8, .72);
                backdrop-filter: blur(9px);
            }

            #${MODAL_ID},
            #${MODAL_ID} * {
                box-sizing: border-box;
            }

            #${MODAL_ID} .hehe-pin-dialog {
                display: grid;
                grid-template-rows: auto auto minmax(0, 1fr) auto;
                width: min(760px, calc(100vw - 28px));
                height: min(760px, calc(100vh - 28px));
                height: min(760px, calc(100dvh - 28px));
                min-width: 0;
                min-height: 0;
                max-width: 100%;
                max-height: 100%;
                overflow: hidden;
                border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #777) 58%, transparent);
                border-radius: 18px;
                background:
                    radial-gradient(circle at 7% 0%, color-mix(in srgb, var(--SmartThemeQuoteColor, #d7ad63) 13%, transparent), transparent 33%),
                    color-mix(in srgb, var(--SmartThemeBlurTintColor, #1d1d1d) 96%, #111);
                box-shadow: 0 28px 80px rgba(0, 0, 0, .48);
            }

            #${MODAL_ID} .hehe-pin-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 18px;
                min-width: 0;
                padding: 22px 22px 14px;
            }

            #${MODAL_ID} .hehe-pin-header > div {
                min-width: 0;
            }

            #${MODAL_ID} .hehe-pin-kicker {
                margin-bottom: 5px;
                color: var(--SmartThemeQuoteColor, #d7ad63);
                font-size: 11px;
                font-weight: 750;
                letter-spacing: .16em;
                text-transform: uppercase;
            }

            #${MODAL_ID} h2 {
                margin: 0;
                font-size: clamp(21px, 4vw, 28px);
                line-height: 1.12;
            }

            #${MODAL_ID} .hehe-pin-subtitle {
                margin: 8px 0 0;
                color: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 68%, transparent);
                font-size: 13px;
                line-height: 1.55;
                overflow-wrap: anywhere;
            }

            #${MODAL_ID} button,
            #${MODAL_ID} input {
                font: inherit;
            }

            #${MODAL_ID} .hehe-pin-icon-button {
                flex: 0 0 auto;
                width: 36px;
                height: 36px;
                border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #777) 55%, transparent);
                border-radius: 10px;
                color: inherit;
                background: rgba(255, 255, 255, .035);
                cursor: pointer;
            }

            #${MODAL_ID} .hehe-pin-toolbar {
                display: flex;
                align-items: center;
                gap: 10px;
                min-width: 0;
                padding: 0 22px 16px;
            }

            #${MODAL_ID} .hehe-pin-search-wrap {
                position: relative;
                flex: 1;
                min-width: 0;
            }

            #${MODAL_ID} .hehe-pin-search-wrap i {
                position: absolute;
                top: 50%;
                left: 13px;
                color: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 55%, transparent);
                transform: translateY(-50%);
                pointer-events: none;
            }

            #${MODAL_ID} .hehe-pin-search {
                box-sizing: border-box;
                width: 100%;
                height: 42px;
                padding: 0 14px 0 38px;
                border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #777) 55%, transparent);
                border-radius: 12px;
                color: inherit;
                outline: none;
                background: rgba(0, 0, 0, .16);
            }

            #${MODAL_ID} .hehe-pin-search:focus {
                border-color: var(--SmartThemeQuoteColor, #d7ad63);
                box-shadow: 0 0 0 3px color-mix(in srgb, var(--SmartThemeQuoteColor, #d7ad63) 15%, transparent);
            }

            #${MODAL_ID} .hehe-pin-count {
                min-width: 80px;
                color: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 68%, transparent);
                font-size: 12px;
                text-align: right;
                white-space: nowrap;
            }

            #${MODAL_ID} .hehe-pin-list {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
                align-content: start;
                gap: 10px;
                min-width: 0;
                min-height: 0;
                overflow: auto;
                padding: 2px 22px 22px;
                overscroll-behavior: contain;
                scrollbar-width: thin;
            }

            #${MODAL_ID} .hehe-pin-card {
                position: relative;
                display: grid;
                grid-template-columns: 50px minmax(0, 1fr);
                align-items: center;
                gap: 10px;
                min-height: 70px;
                padding: 9px;
                border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #777) 46%, transparent);
                border-radius: 13px;
                color: inherit;
                background: rgba(255, 255, 255, .025);
                cursor: pointer;
                user-select: none;
                transition: border-color .16s ease, background .16s ease, transform .16s ease;
            }

            #${MODAL_ID} .hehe-pin-card:hover {
                border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #d7ad63) 56%, transparent);
                background: rgba(255, 255, 255, .055);
                transform: translateY(-1px);
            }

            #${MODAL_ID} .hehe-pin-card.is-selected {
                border-color: var(--SmartThemeQuoteColor, #d7ad63);
                background: color-mix(in srgb, var(--SmartThemeQuoteColor, #d7ad63) 12%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--SmartThemeQuoteColor, #d7ad63) 24%, transparent);
            }

            #${MODAL_ID} .hehe-pin-avatar {
                width: 50px;
                height: 50px;
                border-radius: 11px;
                object-fit: cover;
                background: rgba(0, 0, 0, .2);
            }

            #${MODAL_ID} .hehe-pin-copy {
                display: block;
                min-width: 0;
                max-width: 100%;
                overflow: hidden;
            }

            #${MODAL_ID} .hehe-pin-name {
                display: block;
                max-width: 100%;
                overflow: hidden;
                font-size: 13px;
                font-weight: 700;
                line-height: 1.3;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            #${MODAL_ID} .hehe-pin-title {
                display: -webkit-box;
                margin-top: 4px;
                overflow: hidden;
                color: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 57%, transparent);
                font-size: 11px;
                line-height: 1.35;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 2;
            }

            #${MODAL_ID} .hehe-pin-order {
                position: absolute;
                top: 6px;
                right: 6px;
                display: none;
                min-width: 22px;
                height: 22px;
                place-items: center;
                padding: 0 5px;
                border-radius: 999px;
                color: #17120b;
                background: var(--SmartThemeQuoteColor, #d7ad63);
                font-size: 11px;
                font-weight: 800;
            }

            #${MODAL_ID} .hehe-pin-card.is-selected .hehe-pin-order {
                display: grid;
            }

            #${MODAL_ID} .hehe-pin-empty {
                grid-column: 1 / -1;
                display: grid;
                min-height: 100%;
                place-items: center;
                color: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 58%, transparent);
                font-size: 13px;
                text-align: center;
            }

            #${MODAL_ID} .hehe-pin-footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                min-width: 0;
                padding: 15px 22px 20px;
                border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #777) 35%, transparent);
            }

            #${MODAL_ID} .hehe-pin-actions {
                display: flex;
                gap: 9px;
                margin-left: auto;
            }

            #${MODAL_ID} .hehe-pin-button {
                min-height: 38px;
                padding: 0 15px;
                border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #777) 55%, transparent);
                border-radius: 10px;
                color: inherit;
                background: rgba(255, 255, 255, .045);
                cursor: pointer;
            }

            #${MODAL_ID} .hehe-pin-button.primary {
                border-color: var(--SmartThemeQuoteColor, #d7ad63);
                color: #18120a;
                background: var(--SmartThemeQuoteColor, #d7ad63);
                font-weight: 800;
            }

            #${MODAL_ID} .hehe-pin-button.subtle {
                padding-inline: 8px;
                border-color: transparent;
                color: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 62%, transparent);
                background: transparent;
                font-size: 12px;
            }

            @media (max-width: 560px) {
                #${MODAL_ID} {
                    padding-block: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-bottom));
                    padding-inline: 8px;
                }

                #${MODAL_ID} .hehe-pin-dialog {
                    width: calc(100vw - 16px);
                    height: calc(100vh - 16px);
                    height: calc(100dvh - 16px);
                    max-height: 100%;
                    border-radius: 15px;
                }

                #${MODAL_ID} .hehe-pin-header,
                #${MODAL_ID} .hehe-pin-toolbar,
                #${MODAL_ID} .hehe-pin-footer {
                    padding-inline: 15px;
                }

                #${MODAL_ID} .hehe-pin-list {
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    padding-inline: 15px;
                }

                #${MODAL_ID} .hehe-pin-card {
                    grid-template-columns: 42px minmax(0, 1fr);
                    min-height: 62px;
                }

                #${MODAL_ID} .hehe-pin-avatar {
                    width: 42px;
                    height: 42px;
                }

                #${MODAL_ID} .hehe-pin-title {
                    display: none;
                }
            }

            @media (max-width: 360px) {
                #${MODAL_ID} .hehe-pin-list {
                    grid-template-columns: minmax(0, 1fr);
                }

                #${MODAL_ID} .hehe-pin-count {
                    min-width: auto;
                }

                #${MODAL_ID} .hehe-pin-footer {
                    gap: 6px;
                }

                #${MODAL_ID} .hehe-pin-button {
                    padding-inline: 10px;
                }
            }

            @media (max-height: 620px) {
                #${MODAL_ID} .hehe-pin-header {
                    padding-block: 13px 9px;
                }

                #${MODAL_ID} .hehe-pin-kicker,
                #${MODAL_ID} .hehe-pin-subtitle {
                    display: none;
                }

                #${MODAL_ID} .hehe-pin-toolbar {
                    padding-bottom: 10px;
                }

                #${MODAL_ID} .hehe-pin-footer {
                    padding-block: 10px;
                }
            }
        `;
        hostDocument.head.append(style);
    }

    function normalisePersonaName(value) {
        return String(value ?? '').trim().replace(/[\t ]+/g, ' ');
    }

    function isUsablePersonaName(value) {
        const name = normalisePersonaName(value);
        if (!name || name.length > 64 || /[\r\n]/.test(name)) return false;

        const placeholder = name
            .toLocaleLowerCase()
            .replace(/[\[\]【】\s_-]/g, '');
        if (['unnamedpersona', '未命名user', '未命名用户', '未命名人设'].includes(placeholder)) return false;

        // 旧数据偶尔会把 Persona 正文错放进名称字段。宁可不展示，也不要让正文撑破界面。
        return !/^(基本信息|人设信息|persona|description)\s*[:：]/i.test(name);
    }

    async function getLiveAvatarIds(context) {
        const headers = context?.getRequestHeaders?.({ omitContentType: true }) || {};
        const response = await hostWindow.fetch('/api/avatars/get', {
            method: 'POST',
            headers,
        });

        if (!response.ok) {
            throw new Error(`酒馆头像接口返回 ${response.status}`);
        }

        const ids = await response.json();
        if (!Array.isArray(ids)) {
            throw new Error('酒馆返回的 User 清单格式不正确。');
        }
        return ids;
    }

    function getFullPersonaAvatarPath(id) {
        try {
            if (typeof getPersonaAvatarPath === 'function') {
                const path = getPersonaAvatarPath(id);
                if (path) return path;
            }
        } catch (error) {
            console.debug(`[${SCRIPT_NAME}] 酒馆助手头像路径不可用，改用酒馆原始路径。`, error);
        }

        return new URL(`User Avatars/${encodeURIComponent(id)}`, hostDocument.baseURI).href;
    }

    async function getPersonas() {
        const context = getContext();
        const personaNames = context?.powerUserSettings?.personas || {};
        const personaDescriptions = context?.powerUserSettings?.persona_descriptions || {};
        let liveAvatarIds;

        try {
            liveAvatarIds = await getLiveAvatarIds(context);
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 无法取得酒馆现存 User 清单。`, error);
            throw new Error('无法读取酒馆中真实存在的 User，请稍后重试。');
        }

        return liveAvatarIds
            .filter((id, index, ids) => typeof id === 'string' && id && ids.indexOf(id) === index)
            .filter(id => Object.prototype.hasOwnProperty.call(personaNames, id) && isUsablePersonaName(personaNames[id]))
            .map(id => {
                const name = normalisePersonaName(personaNames[id]);
                const descriptor = personaDescriptions[id] || {};
                const rawTitle = String(descriptor.title || '').trim();
                const title = rawTitle.length <= 100 && !/[\r\n]/.test(rawTitle) ? rawTitle : '';
                const thumbnailAvatar = context?.getThumbnailUrl?.('persona', id) || '';
                const fullAvatar = getFullPersonaAvatarPath(id);

                return {
                    id,
                    name,
                    title,
                    avatar: thumbnailAvatar || fullAvatar,
                    fullAvatar,
                };
            })
            .filter(persona => persona.avatar);
    }

    function notify(message, type = 'success') {
        const toast = hostWindow.toastr?.[type];
        if (typeof toast === 'function') toast(message, SCRIPT_NAME);
        else console.info(`[${SCRIPT_NAME}] ${message}`);
    }

    function personaUiReady() {
        const sort = hostDocument.querySelector('#persona_sort_order');
        if (!host$ || !sort || !hostDocument.querySelector('#user_avatar_block') ||
            !hostDocument.querySelector('#persona_pagination_container')) return false;
        const handlers = typeof host$._data === 'function' ? host$._data(sort, 'events')?.input : null;
        return typeof host$._data === 'function' ? Boolean(handlers?.length) : hostDocument.readyState === 'complete';
    }

    async function performRefresh() {
        if (!personaUiReady() || !wrappedPagination || isDestroyed) return false;
        // 最多重试三次；日常巡检不请求头像，失败后可通过重新打开面板再触发。
        for (let attempt = 0; attempt < 3 && !isDestroyed; attempt++) {
            const completed = waitForPersonaPagination(personaPaginationRevision, 3500);
            host$('#persona_sort_order').trigger('input');
            if (await completed) {
                if (isDestroyed) return false;
                queueDecorateCards();
                return true;
            }
        }
        return false;
    }

    function refreshPersonaList(goToFirstPage = false) {
        if (isDestroyed) return Promise.resolve(false);
        if (goToFirstPage) firstPageRequested = true;
        if (refreshPromise) {
            refreshAgain = true;
            return refreshPromise;
        }
        refreshPromise = (async () => {
            let result = false;
            do {
                refreshAgain = false;
                result = await performRefresh();
            } while (refreshAgain && !isDestroyed);
            return result;
        })().catch(() => false).finally(() => { refreshPromise = null; });
        return refreshPromise;
    }

    function maintain() {
        if (isDestroyed) return;
        try {
            if (!host$) host$ = hostWindow.jQuery || hostWindow.$;
            const patched = patchPersonaPagination();
            watchPersonaList();
            const ready = personaUiReady();
            const signature = JSON.stringify(readPinned());
            const changed = signature !== lastPinnedSignature;
            if (ready && wrappedPagination && (patched || !lastUiReady || changed)) {
                void refreshPersonaList(true);
            }
            if (changed) queueDecorateCards();
            lastUiReady = ready;
            lastPinnedSignature = signature;
        } catch {
            console.warn(`[${SCRIPT_NAME}] 等待酒馆界面准备完成。`);
        }
    }

    function onPersonaPanelClick(event) {
        const target = event.target?.closest?.('#persona-management-button .drawer-icon');
        if (!target || isDestroyed) return;
        const content = hostDocument.querySelector('#persona-management-button .drawer-content');
        // 捕获阶段判断是否正在打开；翻页、选择 User 和关闭面板都不强制回第一页。
        if (!content?.classList.contains('openDrawer')) {
            maintain();
            void refreshPersonaList(true);
        }
    }

    function closeManager() {
        managerGeneration += 1;
        hostDocument.getElementById(MODAL_ID)?.remove();
    }

    async function openManager() {
        closeManager();
        const generation = managerGeneration;
        let personas;
        try {
            personas = await getPersonas();
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 打开置顶管理失败。`, error);
            notify(error?.message || '读取 User 列表失败，请稍后重试。', 'error');
            return;
        }

        if (isDestroyed || generation !== managerGeneration) return;
        // 名称过滤、暂时缺失、头像请求失败都不能当成用户取消置顶。
        const savedPinned = readPinned();
        const selected = [...savedPinned];

        const overlay = hostDocument.createElement('div');
        overlay.id = MODAL_ID;
        overlay.innerHTML = `
            <section class="hehe-pin-dialog" role="dialog" aria-modal="true" aria-labelledby="hehe-pin-title">
                <header class="hehe-pin-header">
                    <div>
                        <div class="hehe-pin-kicker">Persona shelf · v${SCRIPT_VERSION}</div>
                        <h2 id="hehe-pin-title">常用 User 置顶</h2>
                        <p class="hehe-pin-subtitle">勾选后，她们会按数字顺序排在酒馆 User 列表第一页最前面。</p>
                    </div>
                    <button class="hehe-pin-icon-button hehe-pin-close" type="button" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </header>
                <div class="hehe-pin-toolbar">
                    <label class="hehe-pin-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input class="hehe-pin-search" type="search" placeholder="搜索 User 名称或标题…" autocomplete="off">
                    </label>
                    <span class="hehe-pin-count" aria-live="polite"></span>
                </div>
                <div class="hehe-pin-list"></div>
                <footer class="hehe-pin-footer">
                    <button class="hehe-pin-button subtle hehe-pin-clear" type="button">全部取消</button>
                    <div class="hehe-pin-actions">
                        <button class="hehe-pin-button hehe-pin-cancel" type="button">取消</button>
                        <button class="hehe-pin-button primary hehe-pin-save" type="button">保存置顶</button>
                    </div>
                </footer>
            </section>
        `;
        hostDocument.body.append(overlay);

        const list = overlay.querySelector('.hehe-pin-list');
        const search = overlay.querySelector('.hehe-pin-search');
        const count = overlay.querySelector('.hehe-pin-count');

        function render() {
            const query = search.value.trim().toLocaleLowerCase();
            const visible = personas
                .filter(persona => !query || `${persona.name}\n${persona.title}`.toLocaleLowerCase().includes(query))
                .sort((a, b) => {
                    const aOrder = selected.indexOf(a.id);
                    const bOrder = selected.indexOf(b.id);
                    if (aOrder !== -1 || bOrder !== -1) {
                        if (aOrder === -1) return 1;
                        if (bOrder === -1) return -1;
                        return aOrder - bOrder;
                    }
                    return a.name.localeCompare(b.name, 'zh-CN');
                });

            list.replaceChildren();
            count.textContent = `已选 ${selected.length} 个`;

            if (!visible.length) {
                const empty = hostDocument.createElement('div');
                empty.className = 'hehe-pin-empty';
                empty.textContent = query
                    ? '没有找到匹配的 User'
                    : '酒馆中还没有可选择的 User 人设';
                list.append(empty);
                return;
            }

            for (const persona of visible) {
                const order = selected.indexOf(persona.id);
                const card = hostDocument.createElement('button');
                card.type = 'button';
                card.className = `hehe-pin-card${order !== -1 ? ' is-selected' : ''}`;
                card.dataset.personaId = persona.id;
                card.setAttribute('aria-pressed', String(order !== -1));

                const avatar = hostDocument.createElement('img');
                avatar.className = 'hehe-pin-avatar';
                avatar.alt = '';
                avatar.loading = 'lazy';
                let usingFullAvatar = !persona.avatar || persona.avatar === persona.fullAvatar;
                avatar.addEventListener('error', () => {
                    if (!usingFullAvatar && persona.fullAvatar) {
                        usingFullAvatar = true;
                        avatar.src = persona.fullAvatar;
                        return;
                    }

                    // 保留卡片与勾选，不把一次图片加载失败变成取消置顶。
                    avatar.style.visibility = 'hidden';
                    card.title = '头像暂时无法加载，置顶选择不受影响';
                });
                avatar.src = persona.avatar || persona.fullAvatar;

                const text = hostDocument.createElement('span');
                const name = hostDocument.createElement('span');
                const title = hostDocument.createElement('span');
                const number = hostDocument.createElement('span');
                text.className = 'hehe-pin-copy';
                name.className = 'hehe-pin-name';
                name.textContent = persona.name;
                name.title = persona.name;
                title.className = 'hehe-pin-title';
                title.textContent = persona.title || 'User Persona';
                number.className = 'hehe-pin-order';
                number.textContent = order === -1 ? '' : String(order + 1);
                text.append(name, title);
                card.append(avatar, text, number);

                card.addEventListener('click', () => {
                    const index = selected.indexOf(persona.id);
                    if (index === -1) selected.push(persona.id);
                    else selected.splice(index, 1);
                    render();
                });
                list.append(card);
            }
        }

        overlay.querySelector('.hehe-pin-close').addEventListener('click', closeManager);
        overlay.querySelector('.hehe-pin-cancel').addEventListener('click', closeManager);
        overlay.querySelector('.hehe-pin-clear').addEventListener('click', () => {
            selected.splice(0, selected.length);
            render();
        });
        overlay.querySelector('.hehe-pin-save').addEventListener('click', async () => {
            const saved = writePinned(selected);
            closeManager();
            const refreshed = await refreshPersonaList(true);
            if (isDestroyed) return;
            if (!saved.accountSaved && !saved.localSaved) {
                notify('置顶仅在本次打开期间生效，存储暂时不可用，请稍后再保存。', 'warning');
            } else if (!refreshed) {
                notify('置顶记录已保存，列表暂未完成刷新；重新打开 User 面板会重试。', 'warning');
            } else {
                notify(selected.length ? `已保存 ${selected.length} 个常用 User 的置顶顺序。` : '已取消全部 User 置顶。');
            }
        });
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeManager();
        });
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeManager();
        });
        search.addEventListener('input', render);

        render();
        search.focus();
    }

    function compareVersions(a, b) {
        const parse = value => {
            if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('版本号格式不正确。');
            const parts = value.split('.').map(Number);
            if (parts.some(n => !Number.isSafeInteger(n))) throw new Error('版本号超出范围。');
            return parts;
        };
        const left = parse(a), right = parse(b);
        for (let i = 0; i < 3; i++) {
            if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
        }
        return 0;
    }

    function validateUpdate(pkg) {
        if (!pkg || pkg.type !== 'script' || pkg.id !== SCRIPT_ID || pkg.name !== SCRIPT_NAME ||
            typeof pkg.content !== 'string' || typeof pkg.info !== 'string') {
            throw new Error('下载内容不是这份置顶脚本，已停止更新。');
        }
        const versions = [...pkg.content.matchAll(/const SCRIPT_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)';/g)];
        if (versions.length !== 1 || versions[0][1] !== pkg.version) {
            throw new Error('更新包版本与代码不一致，已停止更新。');
        }
        compareVersions(pkg.version, SCRIPT_VERSION);
        if (!pkg.content.includes(`const SCRIPT_ID = '${SCRIPT_ID}';`)) {
            throw new Error('更新包标识不一致，已停止更新。');
        }
        // 只编译检查语法，不执行下载代码；避免把语法损坏的版本写回脚本库。
        try { new Function(pkg.content); } catch {
            throw new Error('更新代码未通过语法检查，已停止更新。');
        }
        return pkg;
    }

    function replaceOwnScript(trees, id, pkg) {
        let matches = 0;
        const visit = items => items.map(item => {
            if (item.type === 'folder') return { ...item, scripts: visit(item.scripts) };
            if (item.id !== id) return item;
            matches += 1;
            const buttons = [...(item.button?.buttons || [])];
            for (const name of [BUTTON_NAME, UPDATE_BUTTON]) {
                if (!buttons.some(button => button.name === name)) buttons.push({ name, visible: true });
            }
            // 保留实际安装 ID、开关、脚本变量和用户自定义按钮，不覆盖整个脚本库。
            return { ...item, content: pkg.content, info: pkg.info,
                button: { ...item.button, buttons } };
        });
        const next = visit(trees);
        if (matches !== 1) throw new Error('无法唯一定位当前全局脚本，未更新任何脚本。');
        return next;
    }

    async function checkForUpdate() {
        if (updateBusy || isDestroyed) return;
        updateBusy = true;
        let timer;
        try {
            if (typeof getScriptId !== 'function' || typeof updateScriptTreesWith !== 'function') {
                throw new Error('当前酒馆助手不支持原位更新接口，请先升级酒馆助手。');
            }
            const installedId = getScriptId();
            updateController = new hostWindow.AbortController();
            timer = hostWindow.setTimeout(() => updateController?.abort(), 15000);
            notify(`正在检查更新，当前版本 v${SCRIPT_VERSION}。`, 'info');
            const url = new URL(UPDATE_URL);
            url.searchParams.set('_check', String(Date.now()));
            const response = await hostWindow.fetch(url.href, {
                cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
                signal: updateController.signal,
            });
            if (!response.ok) throw new Error(`更新地址暂时不可用（${response.status}），继续使用当前版本。`);
            const body = await response.text();
            if (body.length > 2_000_000) throw new Error('更新包大小异常，已停止更新。');
            const pkg = validateUpdate(JSON.parse(body));
            hostWindow.clearTimeout(timer);
            if (isDestroyed) return;
            if (compareVersions(pkg.version, SCRIPT_VERSION) <= 0) {
                notify(`当前 v${SCRIPT_VERSION} 已是此发布地址的最新版本。`, 'info');
                return;
            }
            if (!hostWindow.confirm(`常用 User 置顶：v${SCRIPT_VERSION} → v${pkg.version}\n\n更新此脚本并保留现有置顶和设置？`)) return;
            if (isDestroyed) return;
            // 同步 updater 避免在读取和写回脚本库之间等待网络。
            await updateScriptTreesWith(trees => replaceOwnScript(trees, installedId, pkg), { type: 'global' });
            if (!isDestroyed) notify(`已写入 v${pkg.version}。若界面版本未变化，请重新启用这份脚本。`);
        } catch (error) {
            if (!isDestroyed) {
                const message = error?.name === 'AbortError'
                    ? '检查更新超时，继续使用当前版本。'
                    : error instanceof SyntaxError
                        ? '更新地址没有返回有效脚本，继续使用当前版本。'
                        : error?.message || '更新失败，继续使用当前版本。';
                notify(message, 'warning');
            }
        } finally {
            hostWindow.clearTimeout(timer);
            updateController = null;
            updateBusy = false;
        }
    }

    function destroy() {
        if (isDestroyed) return;
        isDestroyed = true;
        hostWindow.clearInterval(maintenanceTimer);
        updateController?.abort();
        hostDocument.removeEventListener('click', onPersonaPanelClick, true);
        for (const stop of buttonStops) { try { stop(); } catch {} }
        closeManager();
        personaListObserver?.disconnect();
        personaListObserver = null;
        for (const waiter of personaPaginationWaiters) {
            hostWindow.clearTimeout(waiter.timer);
            waiter.resolve(false);
        }
        personaPaginationWaiters.clear();
        restorePersonaPagination();
        hostDocument.getElementById(STYLE_ID)?.remove();
        hostDocument.querySelectorAll('.hehe-persona-pin-badge').forEach(element => element.remove());
        hostDocument.querySelectorAll('.hehe-persona-is-pinned').forEach(element => element.classList.remove('hehe-persona-is-pinned'));
        if (hostWindow[INSTANCE_KEY]?.token === instanceToken) delete hostWindow[INSTANCE_KEY];
    }

    async function initialise() {
        try {
            hostWindow[INSTANCE_KEY]?.destroy?.();
        } catch (error) {
            console.debug(`[${SCRIPT_NAME}] 清理上一份脚本实例时出现非致命错误。`, error);
        }
        hostWindow[INSTANCE_KEY] = { token: instanceToken, destroy };

        installStyles();

        try {
            appendInexistentScriptButtons([
                { name: BUTTON_NAME, visible: true },
                { name: UPDATE_BUTTON, visible: true },
            ]);
            for (const [name, callback] of [[BUTTON_NAME, openManager], [UPDATE_BUTTON, checkForUpdate]]) {
                const subscription = eventOn(getButtonEvent(name), callback);
                if (typeof subscription === 'function') buttonStops.push(subscription);
                else if (typeof subscription?.stop === 'function') buttonStops.push(() => subscription.stop());
            }
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 无法创建酒馆助手脚本按钮。`, error);
            notify(`请在脚本中添加一个名为“${BUTTON_NAME}”的按钮。`, 'warning');
        }

        hostDocument.addEventListener('click', onPersonaPanelClick, true);
        maintain();
        // 只检查本地就绪状态；即使加载超过十秒，后来准备好也能接上。
        maintenanceTimer = hostWindow.setInterval(maintain, 1500);
        console.info(`[${SCRIPT_NAME}] v${SCRIPT_VERSION} 已加载。`);
    }

    $(initialise);
    $(window).on('pagehide', destroy);
})();
