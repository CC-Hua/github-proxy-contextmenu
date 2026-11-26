// ==UserScript==
// @name         GitHub 加速下载代理
// @namespace    https://github.com/CC-Hua/github-proxy-contextmenu
// @version      0.0.8
// @description  在任意页面的 GitHub 下载链接上按自定义键（默认鼠标中键），菜单中提供「GitHub 加速下载代理」，按 gh-proxy 官方转换规则加速 Release / Archive / Raw / Gist / API 下载，支持 5 条官方节点线路切换、复制加速链接与自定义前缀。
// @author       CCHua
// @icon         https://github.githubassets.com/pinned-octocat.svg
// @icon64       https://github.githubassets.com/pinned-octocat.svg
// @match        *://*/*
// @noframes
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @updateURL    https://raw.githubusercontent.com/CC-Hua/github-proxy-contextmenu/main/github-proxy-contextmenu.meta.js
// @downloadURL  https://raw.githubusercontent.com/CC-Hua/github-proxy-contextmenu/main/github-proxy-contextmenu.user.js
// @license      MIT
// ==/UserScript==

/* ==========================================================================
 * 原理说明
 * --------------------------------------------------------------------------
 * Tampermonkey 无「向浏览器原生右键菜单追加项」的 API（属浏览器扩展
 * contextMenus 权限）。因此本脚本采用等效方案：
 *
 * 触发方式（v0.0.4 起）：
 *   默认用「鼠标中键」在 GitHub 下载链接上按下即可弹出菜单，彻底避开
 *   浏览器原生右键菜单。触发键与修饰键组合可在设置面板中自定义：
 *     - 触发按钮：左键 / 中键 / 右键
 *     - 修饰键：Shift / Alt / Ctrl / Meta（需精确匹配，避免误触）
 *   实现：document 捕获阶段监听 mousedown，匹配按钮 + 修饰键且命中
 *   下载链接时 preventDefault + stopPropagation；同时拦截 auxclick
 *   （阻止中键在新标签打开链接）与 click（左键触发时阻止跳转）。
 *   右键不再被接管——浏览器原生菜单在任何场景下都完全可用。
 *
 * 链接识别：用 event.composedPath() 逐层回溯找到命中的 <a href>（穿透 Shadow DOM），
 * 判定是否为 GitHub 可下载资源后才接管，否则一律放行浏览器默认行为。
 *
 * 加速规则（完全对齐 gh-proxy.com 官方转换器的输出）：
 *
 *   原始：https://github.com/o/r/releases/download/v1/a.zip
 *   加速：https://gh-proxy.org/https://github.com/o/r/releases/download/v1/a.zip
 *
 * 即「代理前缀 + 原始完整 URL」，代理侧流式转发并跟随 302 重定向。
 *
 * 关于代理域名（重要，已核对官方转换器前端源码与线上实测）：
 *   gh-proxy.com 是「网站 UI 域名」，官方转换器生成下载链接时
 *   从不使用它；转换器输出的是 5 条 .org 节点线路：
 *     gh-proxy.org / v4.gh-proxy.org / v6.gh-proxy.org
 *     cdn.gh-proxy.org / axisnow.gh-proxy.org
 *   其中 v4.gh-proxy.org 被官方标注为「推荐」。
 *   本脚本默认使用 v4.gh-proxy.org，与官网「转换链接」按钮
 *   输出的默认推荐线路一致。
 *
 * 覆盖资源类型（与官网转换器白名单一致）：
 *   - Release 资产      github.com/{o}/{r}/releases/download|latest/download/{tag}/{file}
 *   - 源码归档          github.com/{o}/{r}/archive/refs/{heads|tags}/…
 *   - Raw 文件          github.com/{o}/{r}/raw/… 与 raw.githubusercontent.com/*
 *   - Gist 原始文件     gist.github.com/{user}/{id}/raw/… 与 gist.githubusercontent.com/*
 *   - 仓库打包          codeload.github.com/*、zipball/tarball
 *   - API 资源          api.github.com/…/releases/assets/…、zipball、tarball
 *   - Git 克隆          github.com/{o}/{r}.git（提供复制加速 clone 命令）
 *
 * 隐私提示：gh-proxy 为第三方公共服务，仅用于公开资源的加速下载，
 * 请勿通过任何代理传输账号凭据或私有仓库内容。
 *
 * 若只希望脚本在 GitHub 站点生效，可把 @match 改为：
 *   @match *://github.com/*
 *   @match *://*.github.com/*
 *   @match *://raw.githubusercontent.com/*
 *   @match *://gist.github.com/*
 *   @match *://codeload.github.com/*
 * ========================================================================== */

(function () {
    'use strict';

    /* ====================== 1. 常量与配置 ====================== */

    var STORE_KEY = 'ghpcm.cfg.v1';

    // 内置线路：与 gh-proxy.com 官方转换器输出的 5 条节点完全一致。
    // 注意 gh-proxy.com 是网站 UI 域名，转换器本身不使用它做加速前缀。
    var PROXIES = [
        { id: 'v4.gh-proxy.org',      label: 'v4.gh-proxy.org',      prefix: 'https://v4.gh-proxy.org/',      desc: '官方推荐 · IPv4 优选' },
        { id: 'gh-proxy.org',         label: 'gh-proxy.org',         prefix: 'https://gh-proxy.org/',         desc: '主站加速' },
        { id: 'v6.gh-proxy.org',      label: 'v6.gh-proxy.org',      prefix: 'https://v6.gh-proxy.org/',      desc: 'IPv6 / IPv4 智能解析' },
        { id: 'cdn.gh-proxy.org',     label: 'cdn.gh-proxy.org',     prefix: 'https://cdn.gh-proxy.org/',     desc: 'Fastly CDN 节点' },
        { id: 'axisnow.gh-proxy.org', label: 'axisnow.gh-proxy.org', prefix: 'https://axisnow.gh-proxy.org/', desc: 'AxisNow 三网优选' }
    ];

    var DEFAULT_CFG = {
        enabled: true,
        proxyId: 'v4.gh-proxy.org',
        customPrefix: '',
        // 触发方式：button 0=左键 1=中键 2=右键；mods 为必须按住的修饰键（精确匹配）
        trigger: { button: 1, shift: false, alt: false, ctrl: false, meta: false }
    };

    // 已是代理/镜像地址时不再二次加速
    var MIRROR_HOST_RE = /(^|\.)(gh-proxy\.(com|org)|ghproxy\.(com|net|cc)|gh\.llkk\.cc|hub\.gitmirror\.com|ghfast\.top|ghps\.cc)$/i;

    // github.com 上的可下载路径（仅一个捕获组：动作段）
    var GH_DL_PATH_RE = /^\/[^/]+\/[^/]+\/(releases\/download|releases\/latest\/download|releases\/assets|archive|raw|zipball|tarball)\//i;

    // 直链型下载域名
    var DIRECT_DL_HOSTS = [
        'raw.githubusercontent.com',
        'codeload.github.com',
        'objects.githubusercontent.com',
        'gist.githubusercontent.com',
        'github-releases.githubusercontent.com'
    ];

    /* ====================== 2. 配置存储 ====================== */

    var store = {
        read: function (key) {
            var raw;
            try {
                raw = (typeof GM_getValue === 'function')
                    ? GM_getValue(key, '')
                    : (window.localStorage.getItem(key) || '');
            } catch (e) {
                raw = '';
            }
            if (!raw) return {};
            if (typeof raw === 'object') return raw;
            try {
                var obj = JSON.parse(raw);
                return (obj && typeof obj === 'object') ? obj : {};
            } catch (e) {
                return {};
            }
        },
        write: function (key, val) {
            var raw = JSON.stringify(val);
            try {
                if (typeof GM_setValue === 'function') GM_setValue(key, raw);
                else window.localStorage.setItem(key, raw);
            } catch (e) { /* 存储失败不影响主流程 */ }
        }
    };

    var cfg = Object.assign({}, DEFAULT_CFG, store.read(STORE_KEY));

    // 配置迁移：早期版本默认线路为 gh-proxy.com，官方转换器实际不使用该域做加速，
    // 已统一改为官方推荐的 v4.gh-proxy.org。旧配置中的失效线路一并剔除。
    (function migrate() {
        var changed = false;
        if (cfg.proxyId === 'gh-proxy.com' || !cfg.proxyId) {
            cfg.proxyId = DEFAULT_CFG.proxyId;
            changed = true;
        }
        var valid = false;
        for (var i = 0; i < PROXIES.length; i++) {
            if (PROXIES[i].id === cfg.proxyId) { valid = true; break; }
        }
        if (!valid) {
            cfg.proxyId = DEFAULT_CFG.proxyId;
            changed = true;
        }
        // v0.0.4 新增触发配置：旧配置缺该字段时补默认值
        if (!cfg.trigger || typeof cfg.trigger !== 'object') {
            cfg.trigger = Object.assign({}, DEFAULT_CFG.trigger);
            changed = true;
        } else {
            var t = cfg.trigger;
            if ([0, 1, 2].indexOf(t.button) < 0) { t.button = DEFAULT_CFG.trigger.button; changed = true; }
            ['shift', 'alt', 'ctrl', 'meta'].forEach(function (k) {
                if (typeof t[k] !== 'boolean') { t[k] = false; changed = true; }
            });
        }
        if (changed) saveCfg();
    })();

    function saveCfg() {
        store.write(STORE_KEY, cfg);
    }

    function activePrefix() {
        var custom = (cfg.customPrefix || '').trim();
        if (custom) return /\/$/.test(custom) ? custom : custom + '/';
        for (var i = 0; i < PROXIES.length; i++) {
            if (PROXIES[i].id === cfg.proxyId) return PROXIES[i].prefix;
        }
        return PROXIES[0].prefix;
    }

    function activeLineLabel() {
        var custom = (cfg.customPrefix || '').trim();
        if (custom) return '自定义 · ' + custom.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        for (var i = 0; i < PROXIES.length; i++) {
            if (PROXIES[i].id === cfg.proxyId) return PROXIES[i].label;
        }
        return PROXIES[0].label;
    }

    function triggerLabel() {
        var t = cfg.trigger || DEFAULT_CFG.trigger;
        var btn = ['左键', '中键', '右键'][t.button] || '中键';
        var mods = [];
        if (t.shift) mods.push('Shift');
        if (t.alt) mods.push('Alt');
        if (t.ctrl) mods.push('Ctrl');
        if (t.meta) mods.push('Meta');
        return (mods.length ? mods.join('+') + '+' : '') + '鼠标' + btn;
    }

    /* ====================== 3. 链接识别与地址转换 ====================== */

    /**
     * 判断地址是否为 GitHub 可加速的下载资源。
     * @returns {{href:string, kind:string, host:string}|null}
     */
    function classify(rawHref) {
        var u;
        try {
            u = new URL(rawHref, location.href);
        } catch (e) {
            return null;
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

        var host = u.hostname.toLowerCase();
        var path = u.pathname;

        // 已是代理地址 → 不处理
        if (MIRROR_HOST_RE.test(host)) return null;

        var kind = null;

        if (DIRECT_DL_HOSTS.indexOf(host) >= 0) {
            kind = (host === 'gist.githubusercontent.com') ? 'Gist 原始文件'
                : (host === 'codeload.github.com') ? '仓库打包'
                : 'Raw 文件';
        } else if (host === 'api.github.com') {
            if (/\/(releases\/assets\/|zipball|tarball)/i.test(path)) kind = 'API 资源';
        } else if (host === 'github.com' || host === 'www.github.com') {
            var m = path.match(GH_DL_PATH_RE);
            if (m) {
                var seg = m[1].toLowerCase();
                if (seg.indexOf('releases') === 0) kind = 'Release 资产';
                else if (seg === 'archive') kind = '源码归档';
                else if (seg === 'raw') kind = 'Raw 文件';
                else kind = '仓库打包';
            } else if (/^\/[^/]+\/[^/]+\.git$/i.test(path)) {
                kind = 'Git 克隆';
            }
        } else if (host === 'gist.github.com') {
            if (/^\/[^/]+\/[^/]+\/raw\//i.test(path)) kind = 'Gist 原始文件';
        }

        if (!kind) return null;

        u.hash = '';
        return { href: u.href, kind: kind, host: host };
    }

    /** 拼接代理前缀；代理前缀 + 原始完整 URL */
    function proxify(href, prefix) {
        var p = /\/$/.test(prefix) ? prefix : prefix + '/';
        return p + String(href).replace(/^http:\/\//i, 'https://');
    }

    /* ====================== 4. 基础 UI：样式 / Toast ====================== */

    var CSS = [
        '.ghpcm-menu,.ghpcm-modal{',
        '--ghpcm-bg:#ffffff;--ghpcm-fg:#1f2328;--ghpcm-muted:#59636e;',
        '--ghpcm-hover:#f2f4f7;--ghpcm-line:rgba(31,35,40,.12);',
        '--ghpcm-accent:#1f6feb;--ghpcm-accent-soft:rgba(31,111,235,.10);',
        '--ghpcm-accent-fg:#1a5fd0;--ghpcm-shadow:0 12px 32px rgba(31,35,40,.18),0 2px 8px rgba(31,35,40,.06);',
        '}',
        '@media (prefers-color-scheme:dark){',
        '.ghpcm-menu,.ghpcm-modal{',
        '--ghpcm-bg:#1c2128;--ghpcm-fg:#e6edf3;--ghpcm-muted:#9198a1;',
        '--ghpcm-hover:#262c36;--ghpcm-line:rgba(240,246,252,.12);',
        '--ghpcm-accent:#4493f8;--ghpcm-accent-soft:rgba(68,147,248,.16);',
        '--ghpcm-accent-fg:#79b8ff;--ghpcm-shadow:0 12px 32px rgba(1,4,9,.6),0 2px 8px rgba(1,4,9,.4);',
        '}}',

        /* 菜单容器 */
        '.ghpcm-menu{position:fixed!important;z-index:2147483000!important;box-sizing:border-box!important;',
        'min-width:240px;max-width:min(360px,calc(100vw - 16px));padding:6px;margin:0!important;',
        'border-radius:12px;background:var(--ghpcm-bg)!important;color:var(--ghpcm-fg)!important;',
        'border:1px solid var(--ghpcm-line)!important;box-shadow:var(--ghpcm-shadow)!important;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif!important;',
        'font-size:13px!important;line-height:1.5!important;text-align:left!important;',
        '-webkit-font-smoothing:antialiased;user-select:none!important;',
        // 动画只做位移缩放，不用 opacity 起手：避免动画被抑制的环境下菜单不可见
        'animation:ghpcm-in .12s ease-out;}',
        '@keyframes ghpcm-in{from{transform:scale(.98)}to{transform:scale(1)}}',

        /* 头部 */
        '.ghpcm-head{padding:6px 10px 7px;}',
        '.ghpcm-title{font-size:12px!important;font-weight:700!important;letter-spacing:.02em;',
        'color:var(--ghpcm-fg)!important;margin:0!important;}',
        '.ghpcm-sub{font-size:11px!important;color:var(--ghpcm-muted)!important;margin:2px 0 0!important;',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

        /* 菜单项 */
        '.ghpcm-item{display:flex!important;align-items:center!important;gap:8px!important;',
        'width:100%!important;box-sizing:border-box!important;padding:7px 10px!important;margin:0!important;',
        'border:0!important;border-radius:7px!important;background:transparent!important;',
        'color:var(--ghpcm-fg)!important;font:inherit!important;text-align:left!important;',
        'cursor:pointer!important;box-shadow:none!important;text-transform:none!important;',
        'text-decoration:none!important;min-height:0!important;line-height:1.5!important;}',
        '.ghpcm-item:hover{background:var(--ghpcm-hover)!important;}',
        '.ghpcm-item:active{transform:translateY(.5px);}',
        '.ghpcm-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.ghpcm-hint{flex:0 0 auto;font-size:11px!important;color:var(--ghpcm-muted)!important;',
        'max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.ghpcm-item.is-primary{background:var(--ghpcm-accent-soft)!important;color:var(--ghpcm-accent-fg)!important;font-weight:600!important;}',
        '.ghpcm-item.is-primary:hover{background:var(--ghpcm-accent-soft)!important;filter:brightness(.97);}',
        '.ghpcm-item.is-check{font-weight:600!important;color:var(--ghpcm-accent-fg)!important;}',
        '.ghpcm-sep{height:1px;margin:5px 8px;background:var(--ghpcm-line);}',

        /* Toast */
        '.ghpcm-toast{position:fixed!important;left:50%!important;bottom:32px!important;',
        'transform:translate(-50%,8px);z-index:2147483001!important;padding:8px 14px!important;',
        'border-radius:8px!important;background:rgba(28,32,38,.94)!important;color:#fff!important;',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif!important;',
        'box-shadow:0 6px 20px rgba(1,4,9,.28)!important;opacity:0;pointer-events:none!important;',
        'max-width:80vw;transition:opacity .18s ease,transform .18s ease;}',
        '.ghpcm-toast.is-show{opacity:1;transform:translate(-50%,0);}',

        /* 设置面板 */
        '.ghpcm-overlay{position:fixed!important;inset:0!important;z-index:2147483002!important;',
        'background:rgba(1,4,9,.42)!important;display:flex!important;align-items:center!important;',
        'justify-content:center!important;padding:16px!important;animation:ghpcm-in .14s ease-out;}',        '.ghpcm-modal{box-sizing:border-box!important;width:400px;max-width:100%;',
        'max-height:calc(100vh - 32px);overflow:auto!important;padding:18px 18px 14px!important;',
        'border-radius:12px!important;background:var(--ghpcm-bg)!important;color:var(--ghpcm-fg)!important;',
        'border:1px solid var(--ghpcm-line)!important;box-shadow:var(--ghpcm-shadow)!important;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif!important;',
        'font-size:13px!important;line-height:1.6!important;text-align:left!important;}',
        '.ghpcm-mt{font-size:14px!important;font-weight:700!important;margin:0 0 2px!important;color:var(--ghpcm-fg)!important;}',
        '.ghpcm-ms{font-size:11px!important;color:var(--ghpcm-muted)!important;margin:0 0 14px!important;}',
        '.ghpcm-row{display:flex!important;align-items:center!important;gap:10px!important;margin:0 0 12px!important;}',
        '.ghpcm-row>label{flex:0 0 76px;font-size:12px!important;color:var(--ghpcm-muted)!important;}',
        '.ghpcm-modal select,.ghpcm-modal input[type=text]{flex:1 1 auto;box-sizing:border-box!important;',
        'height:30px!important;padding:0 8px!important;border-radius:6px!important;',
        'border:1px solid var(--ghpcm-line)!important;background:transparent!important;',
        'color:var(--ghpcm-fg)!important;font:inherit!important;font-size:12px!important;outline:none!important;}',
        '.ghpcm-modal select:focus,.ghpcm-modal input[type=text]:focus{border-color:var(--ghpcm-accent)!important;}',
        '.ghpcm-modal input[type=checkbox]{width:15px!important;height:15px!important;margin:0!important;',
        'accent-color:var(--ghpcm-accent);cursor:pointer!important;}',
        '.ghpcm-mods{flex:1 1 auto;display:flex!important;flex-wrap:wrap!important;gap:4px 10px!important;}',
        '.ghpcm-mod{display:inline-flex!important;align-items:center!important;gap:4px!important;',
        'font-size:11px!important;color:var(--ghpcm-fg)!important;white-space:nowrap!important;cursor:pointer!important;}',
        '.ghpcm-mod input[type=checkbox]{width:14px!important;height:14px!important;}',
        '.ghpcm-note{font-size:11px!important;line-height:1.65!important;color:var(--ghpcm-muted)!important;',
        'margin:10px 0 0!important;padding:9px 10px!important;border-radius:7px!important;',
        'background:var(--ghpcm-hover)!important;}',
        '.ghpcm-note code{font-family:ui-monospace,Consolas,monospace;font-size:11px!important;',
        'line-height:1.5!important;word-break:break-all;display:block;margin:4px 0 6px!important;}',
        '.ghpcm-actions{display:flex!important;align-items:center!important;gap:8px!important;margin:16px 0 0!important;}',
        '.ghpcm-actions .ghpcm-spacer{flex:1 1 auto;}',
        '.ghpcm-btn{box-sizing:border-box!important;height:30px!important;padding:0 14px!important;',
        'border-radius:6px!important;border:1px solid var(--ghpcm-line)!important;',
        'background:transparent!important;color:var(--ghpcm-fg)!important;font:inherit!important;',
        'font-size:12px!important;cursor:pointer!important;box-shadow:none!important;}',
        '.ghpcm-btn:hover{background:var(--ghpcm-hover)!important;}',
        '.ghpcm-btn.is-primary{background:var(--ghpcm-accent)!important;border-color:var(--ghpcm-accent)!important;color:#fff!important;}',
        '.ghpcm-btn.is-primary:hover{filter:brightness(1.06);}'
    ].join('');

    var UI = {
        styleEl: null,
        menu: null,
        toast: null,
        overlay: null,
        point: { x: 0, y: 0 },
        current: null,
        guard: false,
        // 同一次点击的 mousedown + auxclick 都可能到达，用事件时间戳去重：
        // 只忽略「紧随其后、同一按钮」的重复事件，不影响用户真实的连续点击
        lastTriggerAt: 0,
        lastTriggerBtn: -1
    };

    function rootNode() {
        return document.documentElement || document.body;
    }

    function injectStyle() {
        if (UI.styleEl && UI.styleEl.isConnected) return;
        try {
            var el = document.createElement('style');
            el.type = 'text/css';
            el.textContent = CSS;
            rootNode().appendChild(el);
            UI.styleEl = el;
        } catch (e) {
            // DOM 尚未就绪，等下次调用重试
        }
    }

    function toast(msg) {
        injectStyle();
        var el = UI.toast;
        if (!el) {
            el = document.createElement('div');
            el.className = 'ghpcm-toast';
            UI.toast = el;
        }
        if (!el.isConnected) rootNode().appendChild(el);
        el.textContent = msg;
        // 强制重排以便动画重放
        void el.offsetWidth;
        el.classList.add('is-show');
        clearTimeout(el._ghpcmTimer);
        el._ghpcmTimer = setTimeout(function () {
            el.classList.remove('is-show');
        }, 1800);
    }

    /* ====================== 5. 动作执行 ====================== */

    function openTab(url) {
        try {
            if (typeof GM_openInTab === 'function') {
                GM_openInTab(url, { active: true, insert: true });
                return;
            }
        } catch (e) { /* 降级到 window.open */ }
        window.open(url, '_blank', 'noopener');
    }

    function copyText(text) {
        return new Promise(function (resolve) {
            // 优先异步剪贴板 API（HTTPS 页面且处于用户手势内可用）
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () {
                    resolve(true);
                }).catch(function () {
                    resolve(legacyCopy(text));
                });
                return;
            }
            resolve(legacyCopy(text));
        });
    }

    function legacyCopy(text) {
        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(text, 'text');
                return true;
            }
        } catch (e) { /* 继续降级 */ }
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
            rootNode().appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) {
            return false;
        }
    }

    /* ====================== 6. 自定义右键菜单 ====================== */

    function closeMenu() {
        if (UI.menu) {
            if (UI.menu.parentNode) UI.menu.parentNode.removeChild(UI.menu);
            UI.menu = null;
        }
    }

    function clampToViewport(el, x, y) {
        var r = el.getBoundingClientRect();
        var vw = window.innerWidth || document.documentElement.clientWidth || 0;
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        var left = x;
        var top = y;
        if (left + r.width > vw - 8) left = vw - r.width - 8;
        if (left < 8) left = 8;
        if (top + r.height > vh - 8) top = vh - r.height - 8;
        if (top < 8) top = 8;
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }

    function reclamp(el) {
        clampToViewport(el, UI.point.x, UI.point.y);
    }

    function addItem(list, opts) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghpcm-item'
            + (opts.primary ? ' is-primary' : '')
            + (opts.check ? ' is-check' : '');

        var txt = document.createElement('span');
        txt.className = 'ghpcm-txt';
        txt.textContent = opts.label;
        btn.appendChild(txt);

        if (opts.hint) {
            var hint = document.createElement('span');
            hint.className = 'ghpcm-hint';
            hint.textContent = opts.hint;
            btn.appendChild(hint);
        }

        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            try {
                opts.onClick(ev);
            } catch (err) {
                console.error('[gh-proxy-menu]', err);
            }
        });

        list.appendChild(btn);
        return btn;
    }

    function addSep(list) {
        var sep = document.createElement('div');
        sep.className = 'ghpcm-sep';
        list.appendChild(sep);
    }

    function buildHead(title, sub) {
        var head = document.createElement('div');
        head.className = 'ghpcm-head';

        var t = document.createElement('div');
        t.className = 'ghpcm-title';
        t.textContent = title;
        head.appendChild(t);

        if (sub) {
            var s = document.createElement('div');
            s.className = 'ghpcm-sub';
            s.textContent = sub;
            head.appendChild(s);
        }
        return head;
    }

    function renderMain(el, info) {
        el.textContent = '';
        var prefix = activePrefix();
        var proxyUrl = proxify(info.href, prefix);
        var isClone = (info.kind === 'Git 克隆');

        el.appendChild(buildHead('GitHub 加速下载代理', info.kind + ' · ' + activeLineLabel()));

        var list = document.createElement('div');

        if (isClone) {
            addItem(list, {
                label: '复制加速 clone 命令',
                primary: true,
                onClick: function () {
                    copyText('git clone ' + proxyUrl).then(function (ok) {
                        closeMenu();
                        toast(ok ? '已复制 clone 命令' : '复制失败，请手动复制');
                    });
                }
            });
            addItem(list, {
                label: '复制加速仓库地址',
                onClick: function () {
                    copyText(proxyUrl).then(function (ok) {
                        closeMenu();
                        toast(ok ? '已复制加速地址' : '复制失败，请手动复制');
                    });
                }
            });
        } else {
            addItem(list, {
                label: '加速下载',
                hint: '新标签',
                primary: true,
                onClick: function () {
                    closeMenu();
                    openTab(proxyUrl);
                }
            });
            addItem(list, {
                label: '复制加速链接',
                onClick: function () {
                    copyText(proxyUrl).then(function (ok) {
                        closeMenu();
                        toast(ok ? '已复制加速链接' : '复制失败，请手动复制');
                    });
                }
            });
        }

        addSep(list);
        // 一次性复制全部 5 条官方节点链接，与官网「转换链接」的输出形式一致
        addItem(list, {
            label: '复制全部节点链接',
            hint: PROXIES.length + ' 条',
            onClick: function () {
                var lines = PROXIES.map(function (p) {
                    var u = proxify(info.href, p.prefix);
                    return isClone ? ('git clone ' + u) : u;
                });
                copyText(lines.join('\n')).then(function (ok) {
                    closeMenu();
                    toast(ok ? ('已复制 ' + lines.length + ' 条节点链接') : '复制失败，请手动复制');
                });
            }
        });
        addSep(list);
        addItem(list, {
            label: '打开原始链接',
            onClick: function () {
                closeMenu();
                openTab(info.href);
            }
        });
        addItem(list, {
            label: '复制原始链接',
            onClick: function () {
                copyText(info.href).then(function (ok) {
                    closeMenu();
                    toast(ok ? '已复制原始链接' : '复制失败，请手动复制');
                });
            }
        });
        addSep(list);
        addItem(list, {
            label: '切换加速线路',
            hint: activeLineLabel() + ' ›',
            onClick: function () {
                renderLines(el, info);
                reclamp(el);
            }
        });
        addSep(list);
        addItem(list, {
            label: '设置',
            hint: '触发键 / 线路',
            onClick: function () {
                closeMenu();
                openSettings();
            }
        });

        el.appendChild(list);
    }

    function renderLines(el, info) {
        el.textContent = '';
        el.appendChild(buildHead('加速线路', '选择后立即生效并记住'));

        var list = document.createElement('div');
        var usingCustom = !!(cfg.customPrefix || '').trim();

        PROXIES.forEach(function (p) {
            var checked = !usingCustom && p.id === cfg.proxyId;
            addItem(list, {
                label: p.label,
                hint: checked ? '✓ 当前' : (p.desc || ''),
                check: checked,
                onClick: function () {
                    cfg.proxyId = p.id;
                    cfg.customPrefix = '';
                    saveCfg();
                    renderMain(el, info);
                    reclamp(el);
                }
            });
        });

        if (usingCustom) {
            addItem(list, {
                label: '自定义：' + activeLineLabel().replace('自定义 · ', ''),
                hint: '✓ 当前',
                check: true,
                onClick: function () { /* 当前即为自定义 */ }
            });
        }

        addSep(list);
        addItem(list, {
            label: '自定义前缀…',
            hint: '⚙',
            onClick: function () {
                closeMenu();
                openSettings();
            }
        });
        addItem(list, {
            label: '返回',
            hint: '←',
            onClick: function () {
                renderMain(el, info);
                reclamp(el);
            }
        });

        el.appendChild(list);
    }

    function showMenu(info, x, y) {
        closeMenu();
        injectStyle();

        var el = document.createElement('div');
        el.className = 'ghpcm-menu';
        el.setAttribute('role', 'menu');
        // 菜单内的右键交回浏览器原生菜单
        el.addEventListener('contextmenu', function (ev) { ev.stopPropagation(); });

        UI.menu = el;
        UI.point = { x: x, y: y };
        UI.current = info;

        renderMain(el, info);

        el.style.visibility = 'hidden';
        el.style.left = '0px';
        el.style.top = '0px';
        rootNode().appendChild(el);
        clampToViewport(el, x, y);
        el.style.visibility = 'visible';
    }

    /* ====================== 7. 设置面板 ====================== */

    function closeSettings() {
        if (UI.overlay) {
            if (UI.overlay.parentNode) UI.overlay.parentNode.removeChild(UI.overlay);
            UI.overlay = null;
        }
    }

    function openSettings() {
        injectStyle();
        closeSettings();
        closeMenu();

        var overlay = document.createElement('div');
        overlay.className = 'ghpcm-overlay';
        overlay.addEventListener('mousedown', function (ev) {
            if (ev.target === overlay) closeSettings();
        });

        var card = document.createElement('div');
        card.className = 'ghpcm-modal';
        card.setAttribute('role', 'dialog');

        var title = document.createElement('div');
        title.className = 'ghpcm-mt';
        title.textContent = 'GitHub 加速下载代理 · 设置';

        var subtitle = document.createElement('div');
        subtitle.className = 'ghpcm-ms';
        subtitle.textContent = '在 GitHub 下载链接上按触发键即可看到加速菜单';

        // 开关
        var rowEnable = document.createElement('div');
        rowEnable.className = 'ghpcm-row';
        var labEnable = document.createElement('label');
        labEnable.textContent = '启用脚本';
        var chkEnable = document.createElement('input');
        chkEnable.type = 'checkbox';
        chkEnable.checked = !!cfg.enabled;
        rowEnable.appendChild(labEnable);
        rowEnable.appendChild(chkEnable);

        // 触发按钮
        var rowBtn = document.createElement('div');
        rowBtn.className = 'ghpcm-row';
        var labBtn = document.createElement('label');
        labBtn.textContent = '触发按钮';
        var selBtn = document.createElement('select');
        [
            { v: 1, t: '鼠标中键（默认）' },
            { v: 0, t: '鼠标左键' },
            { v: 2, t: '鼠标右键' }
        ].forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = String(o.v);
            opt.textContent = o.t;
            if (o.v === cfg.trigger.button) opt.selected = true;
            selBtn.appendChild(opt);
        });
        rowBtn.appendChild(labBtn);
        rowBtn.appendChild(selBtn);

        // 修饰键（精确匹配）
        var rowMods = document.createElement('div');
        rowMods.className = 'ghpcm-row';
        var labMods = document.createElement('label');
        labMods.textContent = '同时按住';
        var modsBox = document.createElement('div');
        modsBox.className = 'ghpcm-mods';
        [
            { k: 'shift', t: 'Shift' },
            { k: 'alt', t: 'Alt' },
            { k: 'ctrl', t: 'Ctrl' },
            { k: 'meta', t: 'Meta/Win' }
        ].forEach(function (m) {
            var wrap = document.createElement('label');
            wrap.className = 'ghpcm-mod';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!cfg.trigger[m.k];
            cb.setAttribute('data-mod', m.k);
            wrap.appendChild(cb);
            wrap.appendChild(document.createTextNode(m.t));
            modsBox.appendChild(wrap);
        });
        rowMods.appendChild(labMods);
        rowMods.appendChild(modsBox);

        // 线路
        var rowProxy = document.createElement('div');
        rowProxy.className = 'ghpcm-row';
        var labProxy = document.createElement('label');
        labProxy.textContent = '默认线路';
        var selProxy = document.createElement('select');
        PROXIES.forEach(function (p) {
            var opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.label;
            if (p.id === cfg.proxyId) opt.selected = true;
            selProxy.appendChild(opt);
        });
        rowProxy.appendChild(labProxy);
        rowProxy.appendChild(selProxy);

        // 自定义前缀
        var rowCustom = document.createElement('div');
        rowCustom.className = 'ghpcm-row';
        var labCustom = document.createElement('label');
        labCustom.textContent = '自定义前缀';
        var inpCustom = document.createElement('input');
        inpCustom.type = 'text';
        inpCustom.spellcheck = false;
        inpCustom.placeholder = 'https://your-proxy.example/';
        inpCustom.value = cfg.customPrefix || '';
        rowCustom.appendChild(labCustom);
        rowCustom.appendChild(inpCustom);

        var note = document.createElement('div');
        note.className = 'ghpcm-note';
        note.innerHTML = '触发方式：在 GitHub 下载链接上按住设定的修饰键并按触发按钮。'
            + '默认「鼠标中键」且无修饰键；右键不被接管，浏览器原生菜单始终可用。'
            + '加速规则：在原始地址前拼接代理前缀，代理侧流式转发并跟随 302 重定向。'
            + '<code>https://v4.gh-proxy.org/https://github.com/owner/repo/releases/download/v1.0/a.zip</code>'
            + '默认使用官网转换器标注的推荐节点 v4.gh-proxy.org；'
            + '自定义前缀优先于默认线路，留空即使用默认线路。'
            + 'gh-proxy 为第三方公共服务，请勿用于私有仓库或账号凭据。';

        // 按钮
        var actions = document.createElement('div');
        actions.className = 'ghpcm-actions';

        var btnReset = document.createElement('button');
        btnReset.type = 'button';
        btnReset.className = 'ghpcm-btn';
        btnReset.textContent = '恢复默认';
        btnReset.addEventListener('click', function () {
            cfg = Object.assign({}, DEFAULT_CFG);
            cfg.trigger = Object.assign({}, DEFAULT_CFG.trigger);
            saveCfg();
            chkEnable.checked = cfg.enabled;
            selBtn.value = String(cfg.trigger.button);
            [].forEach.call(modsBox.querySelectorAll('input[data-mod]'), function (cb) {
                cb.checked = !!cfg.trigger[cb.getAttribute('data-mod')];
            });
            selProxy.value = cfg.proxyId;
            inpCustom.value = '';
            toast('已恢复默认设置');
        });

        var spacer = document.createElement('div');
        spacer.className = 'ghpcm-spacer';

        var btnCancel = document.createElement('button');
        btnCancel.type = 'button';
        btnCancel.className = 'ghpcm-btn';
        btnCancel.textContent = '取消';
        btnCancel.addEventListener('click', closeSettings);

        var btnSave = document.createElement('button');
        btnSave.type = 'button';
        btnSave.className = 'ghpcm-btn is-primary';
        btnSave.textContent = '保存';
        btnSave.addEventListener('click', function () {
            var custom = inpCustom.value.trim();
            if (custom && !/^https?:\/\/[^\s]+$/i.test(custom)) {
                toast('自定义前缀需以 http(s):// 开头');
                return;
            }
            cfg.enabled = !!chkEnable.checked;
            cfg.proxyId = selProxy.value;
            cfg.customPrefix = custom;
            cfg.trigger = { button: parseInt(selBtn.value, 10) };
            [].forEach.call(modsBox.querySelectorAll('input[data-mod]'), function (cb) {
                cfg.trigger[cb.getAttribute('data-mod')] = !!cb.checked;
            });
            saveCfg();
            closeSettings();
            toast('设置已保存：' + triggerLabel());
        });

        actions.appendChild(btnReset);
        actions.appendChild(spacer);
        actions.appendChild(btnCancel);
        actions.appendChild(btnSave);

        card.appendChild(title);
        card.appendChild(subtitle);
        card.appendChild(rowEnable);
        card.appendChild(rowBtn);
        card.appendChild(rowMods);
        card.appendChild(rowProxy);
        card.appendChild(rowCustom);
        card.appendChild(note);
        card.appendChild(actions);
        overlay.appendChild(card);
        rootNode().appendChild(overlay);

        UI.overlay = overlay;
        setTimeout(function () { try { inpCustom.focus(); } catch (e) { /* 忽略 */ } }, 30);
    }

    /* ====================== 8. 事件绑定 ====================== */

    /** 从事件路径中回溯命中的可加速链接 */
    function resolveTarget(ev) {
        var path;
        try {
            path = (typeof ev.composedPath === 'function' && ev.composedPath()) || [ev.target];
        } catch (e) {
            path = [ev.target];
        }

        for (var i = 0; i < path.length; i++) {
            var node = path[i];
            if (!node || node.nodeType !== 1) continue;

            var raw = null;
            try {
                if (typeof node.href === 'string' && node.href) raw = node.href;
                else if (node.getAttribute) raw = node.getAttribute('href');
            } catch (e) {
                raw = null;
            }
            if (!raw) continue;

            var info = classify(raw);
            if (info) return info;
            // 命中 <a> 但不是下载链接 → 不再向上找父级 a
            if (String(node.tagName).toLowerCase() === 'a') return null;
        }
        return null;
    }

    /** 判断鼠标事件是否匹配用户配置的触发键（按钮 + 修饰键精确匹配） */
    function matchTrigger(ev) {
        var t = cfg.trigger || DEFAULT_CFG.trigger;
        if (ev.button !== t.button) return false;
        return (!!ev.shiftKey === !!t.shift)
            && (!!ev.altKey === !!t.alt)
            && (!!ev.ctrlKey === !!t.ctrl)
            && (!!ev.metaKey === !!t.meta);
    }

    /** 实际触发菜单：由 mousedown 或 auxclick 调用，短窗口内去重 */
    function tryTrigger(ev) {
        if (!cfg.enabled) return;
        if (UI.guard) return;
        if (!matchTrigger(ev)) return;
        if (UI.menu && UI.menu.contains(ev.target)) return;   // 菜单内部交给自己的 click
        if (UI.overlay && UI.overlay.contains(ev.target)) return;

        var now = Date.now();
        // 同一次点击的两个事件间隔通常 <10ms；用 30ms 窗口去重，
        // 且只在按钮相同时去重，避免误伤真实连续点击
        if (UI.lastTriggerBtn === ev.button && now - UI.lastTriggerAt < 30) return;

        var info = resolveTarget(ev);
        if (!info) return;                        // 未命中下载链接 → 放行浏览器默认行为

        ev.preventDefault();                      // 阻止中键新标签、左键跳转等默认行为
        ev.stopPropagation();

        UI.lastTriggerAt = now;
        UI.lastTriggerBtn = ev.button;

        UI.guard = true;
        try {
            showMenu(info, ev.clientX, ev.clientY);
        } finally {
            UI.guard = false;
        }
    }

    /** mousedown 捕获：触发菜单 或 关闭已有菜单（左键/右键主通道） */
    function onMouseDownCapture(ev) {
        if (!cfg.enabled) return;

        // 已有菜单：点击菜单外部则关闭
        if (UI.menu && !UI.menu.contains(ev.target)) closeMenu();
        tryTrigger(ev);
    }

    /**
     * auxclick 捕获：中键触发的关键入口。
     * Chrome 对 <a> 标签的中键点击只派发 auxclick，不派发 mousedown，
     * 因此必须在此处也调用 tryTrigger，否则「中键触发」完全失效。
     */
    function onAuxClickCapture(ev) {
        if (!cfg.enabled) return;
        if (UI.menu && UI.menu.contains(ev.target)) return;
        if (UI.overlay && UI.overlay.contains(ev.target)) return;
        tryTrigger(ev);
        // 兜底：即使菜单已开或去重拦截，命中下载链接的中键仍要阻止新标签打开
        if (matchTrigger(ev) && resolveTarget(ev)) ev.preventDefault();
    }

    /** click：左键触发时阻止链接跳转。
     *  注意：此处绝不能关闭菜单——触发键（尤其是左键）在 mousedown 阶段
     *  已弹出菜单，随后的 click 事件 target 仍是原链接，若在此 closeMenu()
     *  会导致「按下弹出、松开即消失」，菜单项根本点不到。
     *  关闭菜单统一由 mousedown（真实外部点击）负责，与浏览器原生菜单一致。 */
    function onClickCapture(ev) {
        if (cfg.enabled && matchTrigger(ev)) {
            if (!(UI.menu && UI.menu.contains(ev.target))
                && !(UI.overlay && UI.overlay.contains(ev.target))
                && resolveTarget(ev)) {
                ev.preventDefault();
            }
        }
    }

    /** contextmenu：右键不再被接管，原生菜单始终放行。
     *  若右键本身是触发键，此处不得关闭菜单（菜单已在 mousedown 阶段弹出）。 */
    function onContextMenu(ev) {
        if (!cfg.enabled) return;
        if (UI.menu && UI.menu.contains(ev.target)) return;
        if (UI.overlay && UI.overlay.contains(ev.target)) return;
        // 右键作为触发键时，菜单由 mousedown 打开，此处不能关闭
        if (matchTrigger(ev)) return;
        if (UI.menu) closeMenu();
    }

    function onKeyDown(ev) {
        if (ev.key !== 'Escape' && ev.keyCode !== 27) return;
        if (UI.overlay) {
            closeSettings();
            return;
        }
        if (UI.menu) closeMenu();
    }

    function onViewportChange() {
        closeMenu();
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        try {
            GM_registerMenuCommand('设置', openSettings);
            GM_registerMenuCommand('打开 gh-proxy.com 官网', function () {
                openTab('https://gh-proxy.com/');
            });
        } catch (e) { /* 忽略 */ }
    }

    function init() {
        document.addEventListener('mousedown', onMouseDownCapture, true);
        document.addEventListener('auxclick', onAuxClickCapture, true);
        document.addEventListener('click', onClickCapture, true);
        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange, true);
        window.addEventListener('blur', onViewportChange);
        registerMenuCommands();
    }

    init();
})();
