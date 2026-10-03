// 更新时只修改下面的版本号，保存并重新启用脚本。
// 版本须已发布，例如 1.2.0。置顶记录仍保存在原来的位置。
const VERSION = '1.2.2';

(() => {
    const host = window.parent && window.parent !== window ? window.parent : window;
    let stopped = false;
    const onStop = () => { stopped = true; };
    window.addEventListener('pagehide', onStop, { once: true });
    const report = message => {
        if (stopped) return;
        if (typeof host.toastr?.warning === 'function') host.toastr.warning(message, '常用 User 置顶');
        else console.warn(`[常用 User 置顶] ${message}`);
    };
    // 在下载之前移除旧更新按钮，网络失败也不会留下无效入口。
    try {
        if (typeof getScriptButtons === 'function' && typeof replaceScriptButtons === 'function') {
            const buttons = getScriptButtons();
            if (buttons.some(button => button.name === '🔄 检查更新')) {
                replaceScriptButtons(buttons.filter(button => button.name !== '🔄 检查更新'));
            }
        }
    } catch { /* 不影响加载；正式代码启动时会再次清理。 */ }
    if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
        report('版本号格式不正确，请填写类似 1.2.0 的已发布版本。');
        return;
    }
    const url = `https://cdn.jsdelivr.net/gh/koichole213-ui/tavern-pinned-user@v${VERSION}/pinned-user.module.js`;
    import(url).then(module => {
        // 下载尚未完成就停用时，不再启动，也不改变原生列表。
        if (stopped) return;
        if (module.version !== VERSION || typeof module.default !== 'function') {
            throw new Error('version mismatch');
        }
        module.default();
    }).catch(() => {
        report(`v${VERSION} 加载失败。请检查网络和版本号后重新启用；已保存的置顶记录不会删除。`);
    });
})();
