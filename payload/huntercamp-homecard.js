/* ============================================================================
 * HUNTERCAMP 首页「逗逗陪玩」卡片 → 触控板开关卡片   v2
 * ----------------------------------------------------------------------------
 * 做法：找到首页底部那排卡片里的「陪你游戏，伴你生活」卡片（逗逗陪玩），
 *       把它的内容原地换成触控板开关，外观沿用原卡片的 DOM 结构与 class，
 *       只有图标、文案、开关行为是我们自己的。
 *
 * 状态同步：包住 C# 回调 window.webviewBusinessMessage（应用启动时由
 *           injectionWindow() 挂上），从中截获 TouchpadGetResult 的 data.value；
 *           并每 5 秒主动 TouchpadGet 一次，保证和系统/别处的开关一致。
 *
 * 深度优化联动：首页第 6 张卡片上的「深度优化」按钮被点击时（文档级捕获阶段），
 *           把触控板关掉并**保持关闭**（不自动恢复；要开由用户自己点）。
 *           同时派发 document 事件 hc-deep-start，供显卡降压脚本联动。
 *
 * 调试：window.__hcHomeCard.state() / .toggle() / .deep()
 * 卸载：从 build\index.html 移除本文件对应的 <script> 标签
 * ========================================================================== */
(function () {
  'use strict';

  var TAG = '[HC-CARD]';
  var MSG_SET = 'TouchpadSet';
  var MSG_GET = 'TouchpadGet';
  var MSG_RES = 'TouchpadGetResult';
  var PAGE_ID = 'GamePerformance';

  var SLOGAN = '\u966a\u4f60\u6e38\u620f';              /* 陪你游戏 */
  var CARD_SEL = '[class*="ModeCardItemBox_container"]';
  var TXT_OPEN = '\u5f00\u542f';                        /* 开启 */
  var TXT_CLOSE = '\u5173\u95ed';                       /* 关闭 */
  var TXT_NAME = '\u89e6\u63a7\u677f';                  /* 触控板 */
  var TXT_LABEL = '\u6df1\u5ea6\u4f18\u5316\u65f6\u81ea\u52a8\u5173\u95ed'; /* 深度优化时自动关闭 */
  var TXT_DEEP_ON = '\u6df1\u5ea6\u4f18\u5316\u4e2d\u2026';                   /* 深度优化中… */
  var TXT_DEEP = '\u6df1\u5ea6\u4f18\u5316';            /* 深度优化 */
  var DEEP_RESTORE_MS = 12000;

  var current = null;
  var deepRunning = false;
  var deepRestoreTo = null;
  var deepTimer = null;
  var restoreTimer = null;
  var cardEl = null;
  var switchBtn = null;
  var stateText = null;

  function log() {
    try {
      var a = [TAG];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.log.apply(console, a);
    } catch (e) {}
  }

  /* ---------- 编解码（与原 bundle 的 base64Utils 一致） ---------- */
  function toB64(str) {
    var enc = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < enc.length; i++) bin += String.fromCharCode(enc[i]);
    return btoa(bin);
  }
  function fromB64(str) {
    var bin = atob(str), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(arr);
  }

  function send(msgID, data) {
    var payload = { msgID: msgID, status: '', code: '', pageID: PAGE_ID, data: data };
    try {
      var b = window.pcHonorBridge;
      if (b && typeof b.actionBusiness === 'function') {
        b.actionBusiness(toB64(JSON.stringify(payload)));
        return true;
      }
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(JSON.stringify(payload));
        return true;
      }
    } catch (e) { log('send error', e && e.message); }
    return false;
  }

  function asBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'true';
    if (typeof v === 'number') return v !== 0;
    return null;
  }

  /* ---------- 触控板图标 ---------- */
  function touchpadSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'fill="none" width="0.36rem" height="0.36rem" viewBox="0 0 36 36">' +
      '<defs>' +
      '<linearGradient x1="0" y1="0" x2="0.87" y2="0.64" id="hcTpGrad">' +
      '<stop offset="0%" stop-color="#55628A" stop-opacity="0.59"></stop>' +
      '<stop offset="100%" stop-color="#E8F0FF" stop-opacity="0.85"></stop>' +
      '</linearGradient>' +
      '<linearGradient x1="0.5" y1="0" x2="0.5" y2="1" id="hcTpGrad2">' +
      '<stop offset="0%" stop-color="#FFFFFF" stop-opacity="1"></stop>' +
      '<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.25"></stop>' +
      '</linearGradient>' +
      '</defs>' +
      '<rect x="5" y="6" width="26" height="24" rx="4.5" stroke="url(#hcTpGrad)" stroke-width="1.6" fill="none"></rect>' +
      '<path d="M5 12.5h26" stroke="url(#hcTpGrad)" stroke-width="1.1" opacity="0.75"></path>' +
      '<path d="M11 20.5h14" stroke="url(#hcTpGrad2)" stroke-width="1.6" stroke-linecap="round" opacity="0.9"></path>' +
      '<circle cx="18" cy="16.4" r="1.5" fill="url(#hcTpGrad2)" opacity="0.85"></circle>' +
      '</svg>';
  }

  /* ---------- 状态渲染 ---------- */
  function paint() {
    if (!cardEl) return;
    var on = current === true || (current === null && !deepRunning);
    if (stateText) stateText.textContent = on ? TXT_OPEN : TXT_CLOSE;
    if (switchBtn) {
      switchBtn.setAttribute('aria-checked', on ? 'true' : 'false');
      var cls = switchBtn.className || '';
      cls = cls.replace(/\s*ant-switch-checked/g, '');
      if (on) cls += ' ant-switch-checked';
      switchBtn.className = cls;
    }
    var label = cardEl.querySelector('[class*="ModeCardItemBox_label"]');
    if (label) label.textContent = deepRunning ? TXT_DEEP_ON : TXT_LABEL;
    cardEl.style.opacity = deepRunning ? '0.72' : '';
  }

  function setTouchpad(v) {
    current = !!v;
    paint();
    send(MSG_SET, { value: !!v });
    setTimeout(function () { send(MSG_GET, {}); }, 900);
  }

  /* ---------- 深度优化联动 ----------
     按下「深度优化」就把触控板关掉，并且**保持关闭**（不自动恢复）；
     要不要再打开由用户自己点开关决定。 */
  function deepStart() {
    if (deepRunning) return;
    deepRunning = true;
    /* 无条件发一次「关」：本地的 current 可能因为回调延迟/旧状态而不准，问了也是白问 */
    send(MSG_SET, { value: false });
    probe('deepstart-send');
    current = false;
    paint();
    log('深度优化开始 → 触控板关闭（保持，不自动恢复）');

    /* 通知其它注入脚本（显卡降压）做联动动作 */
    try {
      document.dispatchEvent(new CustomEvent('hc-deep-start', { detail: { from: TAG } }));
    } catch (e) { log('派发 hc-deep-start 失败', e && e.message); }

    if (deepTimer) clearTimeout(deepTimer);
    /* 「深度优化中…」只显示一小会儿，之后回到正常外观；开关状态不变 */
    deepTimer = setTimeout(function () {
      deepRunning = false;
      paint();
      send(MSG_GET, {});
    }, 1500);

    /* 应用自己在深度优化结束约 12 秒后会把触控板开回来；
       用户要的是「关了就关着」，所以在这之后再压一次（只在真被开回来时才压）。 */
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(function () {
      if (deepRunning) return;
      send(MSG_GET, {});
      setTimeout(function () {
        if (current === true) {
          log('检测到应用把触控板开回来了 → 重新关闭');
          send(MSG_SET, { value: false });
          current = false;
          paint();
        }
      }, 1200);
    }, 13000);
  }

  /* 判断这次点击是不是落在「深度优化」按钮上：
     逐层看祖先文本不够稳（按钮内可能嵌 span/svg），所以三条路都试：
     ① composedPath ② 祖先链 up to 8 层 ③ 点击点上的 elementsFromPoint */
  function looksLikeDeep(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = (el.textContent || '').trim();
    return t.length > 0 && t.length <= 8 && t.indexOf(TXT_DEEP) >= 0;
  }

  function hitDeep(ev) {
    try {
      var path = (ev.composedPath && ev.composedPath()) || [];
      for (var i = 0; i < path.length && i < 10; i++) {
        if (looksLikeDeep(path[i])) return true;
      }
      var el = ev.target;
      for (var j = 0; el && j < 8; j++, el = el.parentElement) {
        if (looksLikeDeep(el)) return true;
      }
      if (document.elementsFromPoint) {
        var at = document.elementsFromPoint(ev.clientX, ev.clientY) || [];
        for (var k = 0; k < at.length && k < 6; k++) {
          if (looksLikeDeep(at[k])) return true;
        }
      }
    } catch (e) { log('hitDeep error', e && e.message); }
    return false;
  }

  var lastDeepClickAt = 0;

  function installDeepHook() {
    if (installDeepHook.done) return;
    installDeepHook.done = true;
    document.addEventListener('click', function (ev) {
      /* 程序化合成点击（element.click()）detail=0，跳过；OS 注入/真人点击 detail>=1 放行 */
      if (typeof ev.detail === 'number' && ev.detail === 0) return;
      if (hitDeep(ev)) {
        log('识别到深度优化点击');
        lastDeepClickAt = Date.now();
        deepStart();
      }
    }, true);
  }

  /* ---------- 收到 C# 回调（截获触控板状态） ---------- */
  function wrapReceive() {
    var orig = window.webviewBusinessMessage;
    if (typeof orig !== 'function' || orig.__hcWrapped) return;
    var wrapped = function (str) {
      try {
        var msg = JSON.parse(fromB64(str));
        if (msg && msg.msgID === MSG_RES) {
          var v = asBool(msg.data && typeof msg.data === 'object' ? msg.data.value : msg.data);
          if (v !== null && !deepRunning) { current = v; paint(); }
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped.__hcWrapped = true;
    window.webviewBusinessMessage = wrapped;
  }

  function installListener() {
    wrapReceive();
    setInterval(wrapReceive, 800);     /* 应用可能重新赋值，保持包装 */
    setInterval(function () { send(MSG_GET, {}); }, 5000);
    setInterval(function () { if (!cardEl) return; send(MSG_GET, {}); }, 15000);
  }

  /* ---------- 找到并改造卡片 ---------- */
  function findDoudouCard() {
    var list = document.querySelectorAll(CARD_SEL);
    for (var i = 0; i < list.length; i++) {
      if ((list[i].textContent || '').indexOf(SLOGAN) >= 0) return list[i];
    }
    return null;
  }

  function build() {
    var target = findDoudouCard();
    if (!target) return false;
    if (target.getAttribute('data-hc-touchpad') === '1') {
      cardEl = target;
      if (!stateText) stateText = target.querySelector('[class*="ModeCardItemBox_switchText"]');
      if (!switchBtn) switchBtn = target.querySelector('[role="switch"]');
      return true;
    }

    var content = target.querySelector('[class*="ModeCardItemBox_content"]');
    var bottom = target.querySelector('[class*="ModeCardItemBox_bottomView"]');
    if (!content || !bottom) return false;

    target.setAttribute('data-hc-touchpad', '1');
    target.setAttribute('title', TXT_NAME);

    /* 1) 图标替换 */
    var oldSvg = bottom.querySelector('svg');
    if (oldSvg && oldSvg.parentNode) {
      var holder = document.createElement('div');
      holder.innerHTML = touchpadSvg();
      oldSvg.parentNode.replaceChild(holder.firstChild, oldSvg);
    } else {
      bottom.insertAdjacentHTML('afterbegin', touchpadSvg());
    }

    /* 2) 文案替换 */
    var label = target.querySelector('[class*="ModeCardItemBox_label"]');
    if (label) label.textContent = TXT_LABEL;

    var nameEl = target.querySelector('[class*="ModeCardItemBox_name"]');
    if (nameEl) nameEl.textContent = TXT_NAME;

    stateText = target.querySelector('[class*="ModeCardItemBox_switchText"]');
    switchBtn = target.querySelector('[role="switch"]');

    /* 3) 点击行为：整卡可点，捕获阶段拦掉原来「打开逗逗」的处理器 */
    function onToggle(ev) {
      /* 忽略应用自己发出的程序化点击（element.click() / dispatchEvent 没有指针计数 detail=0），
         否则启动时它会对卡片行做一次合成点击，把触控板误切换。真人点击 detail>=1 放行。 */
      if (ev && typeof ev.detail === 'number' && ev.detail === 0) return;
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      }
      if (deepRunning) { log('深度优化中，忽略点击'); return; }
      var next = current === true ? false : true;
      log('切换触控板 ->', next);
      setTouchpad(next);
    }
    target.addEventListener('click', onToggle, true);
    if (switchBtn) switchBtn.addEventListener('click', onToggle, true);

    cardEl = target;
    paint();
    send(MSG_GET, {});
    log('首页卡片已替换为触控板开关');
    return true;
  }

  /* ---------- 截获「深度优化」按下 ----------
     应用把 "深度优化" 变成一条发给主进程的 {msgID:'StartDeep'} 消息。
     直接包 window.btoa 最稳：bundle 里的 base64 编码器（module 4136）是在调用时才取全局 btoa，
     而它对 window.pcHonorBridge.actionBusiness 的引用是在模块初始化时抓进闭包的（换掉属性没用）。
     这样既能拿到"真的开始深度优化"的时刻，又不依赖按钮文案/DOM 结构，也不受合成点击过滤影响。 */
  var MSG_START_DEEP = 'StartDeep';

  function probe(tag) {
    try {
      fetch('http://127.0.0.1:8977/ping?hc=' + encodeURIComponent(tag), { cache: 'no-store' })
        .catch(function () {});
    } catch (e) {}
  }

  function wrapBtoa() {
    var orig = window.btoa;
    if (typeof orig !== 'function' || orig.__hcWrapped) return true;
    var wrapped = function (s) {
      try {
        if (typeof s === 'string' && s.indexOf(MSG_START_DEEP) >= 0) {
          /* 只在「刚刚真的点了深度优化按钮」时才联动：
             应用启动时也会自动按存档模式跑一次深度优化（同样发 StartDeep），
             那种情况下不应该动用户的触控板。 */
          var fresh = (Date.now() - lastDeepClickAt) < 15000;
          if (!fresh) { log('截获 StartDeep（启动自动执行，跳过联动）'); return orig.apply(this, arguments); }
          log('截获 StartDeep → 触发联动');
          probe('STARTDEEP');
          setTimeout(function () { deepStart(); }, 0);
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped.__hcWrapped = true;
    window.btoa = wrapped;
    log('已接管 btoa（深度优化探测）');
    probe('wrap:btoa');
    return true;
  }

  /* ---------- 路由/重渲染守护 ---------- */
  function ensure() {
    try {
      var path = (location.pathname || '') + (location.hash || '');
      if (!(/\/home/i.test(path) || path === '/' || path === '')) return;
      if (!document.body) return;
      if (!installDeepHook.done) installDeepHook();
      build();
      if (cardEl && !document.body.contains(cardEl)) {
        cardEl = null;
        build();
      }
    } catch (e) { log('ensure error', e && e.message); }
  }

  function boot() {
    installListener();
    wrapBtoa();
    ensure();
    setInterval(ensure, 1500);

    try {
      var obs = new MutationObserver(function () { ensure(); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}

    log('补丁已加载 v4');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.__hcHomeCard = {
    state: function () { return current; },
    deepRunning: function () { return deepRunning; },
    toggle: function () { setTouchpad(current === true ? false : true); },
    deep: function () { deepStart(); },
    remount: function () { cardEl = null; return build(); }
  };
})();
