/* HunterCamp 逗逗陪玩彻底移除 —— 注入脚本
 * 作用：
 *   1. 隐藏左侧导航里的「AI 伙伴 / 逗逗」入口（路由 /gameassistant/aicompanion）
 *   2. 隐藏游戏性能页里的「逗逗陪玩」开关行
 *   3. 阻止任何跳转到 aicompanion 路由的行为
 * 与 huntercamp-touchpad.js 同一套机制，删除本文件并去掉 index.html 里的引用即可还原。
 */
(function () {
  'use strict';

  var CSS = 'a[href*="/aicompanion"]{display:none!important}';
  var HIDDEN_TEXT = '逗逗';

  function ensureCss() {
    if (document.getElementById('hc-nodoudou-css')) return;
    var s = document.createElement('style');
    s.id = 'hc-nodoudou-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function killNav() {
    var links = document.querySelectorAll('a[href*="aicompanion"], [href*="aicompanion"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var li = a.closest ? a.closest('li') : null;
      var target = li || a;
      if (target && target.parentNode) target.parentNode.removeChild(target);
    }
  }

  function killDoudouRows() {
    var nodes = document.querySelectorAll('div, li, section, p, span');
    for (var i = nodes.length - 1; i >= 0; i--) {
      var el = nodes[i];
      if (!el.isConnected) continue;
      var txt = el.textContent || '';
      if (txt.length > 40) continue;              // 只在短文本节点里找，避免误删大容器
      if (txt.indexOf(HIDDEN_TEXT) < 0) continue;
      if (el.children.length > 6) continue;
      var row = (el.closest && el.closest('[class*="item"],[class*="row"],[class*="card"]')) || el;
      if (row && row.parentNode) row.parentNode.removeChild(row);
    }
  }

  function guardRoute() {
    try {
      if (location.pathname.indexOf('/aicompanion') >= 0) {
        history.replaceState(null, '', '/');
      }
    } catch (e) { /* ignore */ }
  }

  function apply() {
    try {
      ensureCss();
      killNav();
      guardRoute();
      killDoudouRows();
    } catch (e) { /* ignore */ }
  }

  function boot() {
    apply();
    // DOM 变化后（React 重新渲染 / 切页）再补一刀，做节流
    var timer = null;
    var obs = new MutationObserver(function () {
      if (timer) return;
      timer = setTimeout(function () { timer = null; apply(); }, 250);
    });
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    // 路由切换（pushState）也补一刀
    var push = history.pushState;
    history.pushState = function () {
      var r = push.apply(this, arguments);
      setTimeout(apply, 60);
      return r;
    };
    setInterval(guardRoute, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
