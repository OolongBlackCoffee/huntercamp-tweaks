/* ============================================================================
 * HUNTER CAMP —— 基础优化项「显卡降压」卡片 + V/F 曲线调节面板
 * ----------------------------------------------------------------------------
 * 后端：本地服务 http://127.0.0.1:8977（HcGpuSvc.exe，SYSTEM 计划任务，走 NVAPI 私有接口）
 *   GET /ping            服务状态
 *   GET /curve           当前 V/F 曲线（127 点）
 *   GET /apply?mv=&mhz=  把 mv 及以上拉平到 mhz
 *   GET /clear           恢复默认（偏移全部清零）
 *
 * 前端：在首页卡片行末尾追加一张「显卡降压」卡片，点击弹出曲线面板。
 * 调试：window.__hcUv.open() / .close() / .reload()
 * ========================================================================== */
(function () {
  'use strict';

  var TAG = '[HC-UV]';
  var API = 'http://127.0.0.1:8977';
  var CARD_SEL = '[class*="ModeCardItemBox_container"]';
  var TXT_NAME = '\u663e\u5361\u964d\u538b';            /* 显卡降压 */
  var TXT_SUB = '\u8c03\u7535\u538b\u66f2\u7ebf'; /* 调电压曲线 */

  var cardEl = null;
  var panel = null;
  var canvas = null;
  var points = [];          /* [{mv, mhz, base, delta}] */
  var capMv = 925;
  var capMhz = 0;
  var busy = false;

  function log() {
    try {
      var a = [TAG];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.log.apply(console, a);
    } catch (e) {}
  }

  function api(path, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', API + path, true);
      xhr.timeout = timeoutMs || 4000;
      xhr.onload = function () {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error('\u54cd\u5e94\u89e3\u6790\u5931\u8d25')); }
      };
      xhr.onerror = function () { reject(new Error('\u670d\u52a1\u672a\u542f\u52a8')); };
      xhr.ontimeout = function () { reject(new Error('\u670d\u52a1\u8d85\u65f6')); };
      xhr.send();
    });
  }

  /* ---------- 卡片 ---------- */
  var CARD_STYLE_ID = 'hc-uv-card-style';
  function injectCardStyle() {
    if (document.getElementById(CARD_STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = CARD_STYLE_ID;
    /* 卡片行原本按 6 张卡排布（每张 1.29rem + 右侧 .2rem），第 7 张会溢出右边界；
       加入后把整行压窄到 7 张正好排满 */
    st.textContent = '.hc-uv-row > *{width:1.16rem!important;margin-right:.09rem!important;}'
      + '.hc-uv-row > *:last-child{margin-right:0!important;}'
      + '[data-hc-uv="1"]{cursor:pointer;}';
    document.head.appendChild(st);
  }


  function gaugeSvg() {
    var c = '#ff4d6d';
    return '<svg width="40" height="32" viewBox="0 0 40 32" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5 26a15 15 0 1 1 30 0" stroke="' + c + '" stroke-width="3" stroke-linecap="round" opacity="0.55"/>' +
      '<path d="M20 26L28 13" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
      '<circle cx="20" cy="26" r="3.2" fill="' + c + '"/>' +
      '</svg>';
  }

  function findCards() {
    return document.querySelectorAll(CARD_SEL);
  }

  function build() {
    var list = findCards();
    if (!list.length) return false;
    if (document.querySelector('[data-hc-uv="1"]')) return true;

    var tpl = null;
    for (var i = 0; i < list.length; i++) {
      if ((list[i].getAttribute('data-hc-uv') || '') !== '1') { tpl = list[i]; break; }
    }
    if (!tpl || !tpl.parentNode) return false;

    var clone = tpl.cloneNode(true);
    clone.setAttribute('data-hc-uv', '1');
    clone.removeAttribute('data-hc-touchpad');
    clone.setAttribute('title', TXT_NAME);
    clone.style.cursor = 'pointer';

    /* 图标 */
    var bottom = clone.querySelector('[class*="ModeCardItemBox_bottomView"]');
    if (bottom) {
      var svg = bottom.querySelector('svg');
      if (svg && svg.parentNode) {
        var holder = document.createElement('div');
        holder.innerHTML = gaugeSvg();
        svg.parentNode.replaceChild(holder.firstChild, svg);
      }
    }
    /* 文案 */
    var nameEl = clone.querySelector('[class*="ModeCardItemBox_name"]');
    if (nameEl) nameEl.textContent = TXT_NAME;
    var labelEl = clone.querySelector('[class*="ModeCardItemBox_label"]');
    if (labelEl) labelEl.textContent = TXT_SUB;

    /* 去掉原卡片的开关，换成一个小箭头提示 */
    var switchEl = clone.querySelector('[role="switch"]');
    if (switchEl && switchEl.parentNode) {
      var arrow = document.createElement('span');
      arrow.textContent = '\u203a';
      arrow.style.cssText = 'margin-left:auto;font-size:18px;line-height:1;opacity:.55;';
      switchEl.parentNode.replaceChild(arrow, switchEl);
    }
    var textEl = clone.querySelector('[class*="ModeCardItemBox_switchText"]');
    if (textEl) textEl.style.display = 'none';

    clone.addEventListener('click', function (ev) {
      /* 只挡程序化合成点击（element.click() / dispatchEvent 的 detail=0）：
         应用自身在启动/刷新时会对卡片行做一次这种点击，放过它，否则面板会自己弹出来；
         OS 注入与真人点击 detail>=1，正常放行。 */
      if (typeof ev.detail === 'number' && ev.detail === 0) return;
      ev.preventDefault(); ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      open();
    }, true);

    tpl.parentNode.appendChild(clone);
    cardEl = clone;
    fitRow();
    return true;
  }

  /* 卡片行原本按 6 张排布（每张 1.29rem + 右侧 .2rem 间距），第 7 张会溢出右边界。
     直接把整行的卡片压窄一点，7 张正好排满。 */
  var rowFitted = false;
  function fitRow() {
    try {
      var card = document.querySelector('[data-hc-uv="1"]');
      if (!card || !card.parentNode) return;
      var parent = card.parentNode;
      if (parent.children.length < 7) return;
      if (parent.getAttribute('data-hc-uv-row') === '1') return;
      parent.setAttribute('data-hc-uv-row', '1');
      parent.classList.add('hc-uv-row');
      if (!rowFitted) { rowFitted = true; log('卡片行已压窄，子节点 ' + parent.children.length); }
    } catch (e) { log('fitRow error', e && e.message); }
  }

  /* ---------- 面板 ---------- */
  var STYLE_ID = 'hc-uv-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#hc-uv-mask{position:fixed;inset:0;background:rgba(6,8,14,.62);backdrop-filter:blur(3px);z-index:2147483000;display:flex;align-items:center;justify-content:center;font-family:"Microsoft YaHei",system-ui,sans-serif;}'
      + '#hc-uv-panel{width:720px;max-width:92vw;background:linear-gradient(160deg,#1b1d2b 0%,#15161f 60%,#1a1220 100%);border:1px solid rgba(255,255,255,.10);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.6);color:#eef0f6;overflow:hidden;}'
      + '#hc-uv-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);}'
      + '#hc-uv-title{font-size:16px;font-weight:600;letter-spacing:.5px;}'
      + '#hc-uv-gpu{font-size:12px;color:#8b93a7;margin-left:auto;}'
      + '#hc-uv-close{cursor:pointer;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#9aa3b8;}'
      + '#hc-uv-close:hover{background:rgba(255,255,255,.08);color:#fff;}'
      + '#hc-uv-body{padding:14px 20px 6px;}'
      + '#hc-uv-canvas{width:100%;height:272px;display:block;border-radius:10px;background:radial-gradient(120% 120% at 0% 0%,rgba(255,77,109,.10),rgba(255,255,255,.02) 60%,rgba(255,255,255,.01));cursor:crosshair;}'
      + '#hc-uv-legend{display:flex;gap:16px;font-size:12px;color:#8b93a7;margin:8px 2px 0;}'
      + '.hc-uv-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;}'
      + '#hc-uv-ctrl{display:flex;flex-direction:column;gap:12px;padding:14px 20px 4px;}'
      + '.hc-uv-row{display:flex;align-items:center;gap:12px;}'
      + '.hc-uv-k{width:78px;font-size:13px;color:#9aa3b8;}'
      + '.hc-uv-v{width:104px;text-align:right;font-size:13px;color:#fff;font-variant-numeric:tabular-nums;}'
      + '.hc-uv-row input[type=range]{flex:1;-webkit-appearance:none;height:4px;border-radius:2px;background:linear-gradient(90deg,#ff4d6d,#ff8a5c);outline:none;}'
      + '.hc-uv-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #ff4d6d;box-shadow:0 0 8px rgba(255,77,109,.6);cursor:pointer;}'
      + '#hc-uv-foot{display:flex;align-items:center;gap:10px;padding:14px 20px 18px;}'
      + '.hc-uv-btn{padding:9px 18px;border-radius:9px;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e6e9f2;}'
      + '.hc-uv-btn:hover{background:rgba(255,255,255,.10);}'
      + '.hc-uv-btn.primary{background:linear-gradient(135deg,#ff4d6d,#ff7a4d);border:none;color:#fff;font-weight:600;}'
      + '.hc-uv-btn.primary:hover{filter:brightness(1.08);}'
      + '.hc-uv-btn[disabled]{opacity:.45;cursor:default;}'
      + '#hc-uv-msg{margin-left:auto;font-size:12px;color:#8b93a7;}'
      + '.hc-uv-preset{padding:5px 10px;border-radius:7px;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#b9c0d0;}'
      + '.hc-uv-preset:hover{border-color:rgba(255,77,109,.6);color:#fff;}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function open() {
    if (panel) { panel.style.display = 'flex'; reload(); return; }
    injectStyle();
    var mask = document.createElement('div');
    mask.id = 'hc-uv-mask';
    mask.innerHTML = ''
      + '<div id="hc-uv-panel">'
      + '  <div id="hc-uv-head">'
      + '    <span id="hc-uv-title">' + TXT_NAME + '</span>'
      + '    <span id="hc-uv-gpu">\u8bfb\u53d6\u4e2d\u2026</span>'
      + '    <span id="hc-uv-close">\u2715</span>'
      + '  </div>'
      + '  <div id="hc-uv-body">'
      + '    <canvas id="hc-uv-canvas"></canvas>'
      + '    <div id="hc-uv-legend">'
      + '      <span><i class="hc-uv-dot" style="background:#6fd6c4"></i>\u5f53\u524d\u66f2\u7ebf</span>'
      + '      <span><i class="hc-uv-dot" style="background:#ff4d6d"></i>\u964d\u538b\u540e</span>'
      + '      <span style="color:#5d6478">\u62d6\u52a8\u66f2\u7ebf\u4e0a\u7684\u5706\u70b9\u5373\u53ef\u8c03\u8282</span>'
      + '    </div>'
      + '  </div>'
      + '  <div id="hc-uv-ctrl">'
      + '    <div class="hc-uv-row"><span class="hc-uv-k">\u7535\u538b\u4e0a\u9650</span><input id="hc-uv-mv" type="range" min="700" max="1250" step="5"><span class="hc-uv-v" id="hc-uv-mv-v">925 mV</span></div>'
      + '    <div class="hc-uv-row"><span class="hc-uv-k">\u9891\u7387</span><input id="hc-uv-mhz" type="range" min="1200" max="2800" step="15"><span class="hc-uv-v" id="hc-uv-mhz-v">--</span></div>'
      + '    <div class="hc-uv-row" style="gap:8px">'
      + '      <span class="hc-uv-k">\u9884\u8bbe</span>'
      + '      <span class="hc-uv-preset" data-p="900">900mV</span>'
      + '      <span class="hc-uv-preset" data-p="925">925mV</span>'
      + '      <span class="hc-uv-preset" data-p="950">950mV</span>'
      + '      <span class="hc-uv-preset" data-p="975">975mV</span>'
      + '      <span class="hc-uv-preset" data-p="1000">1000mV</span>'
      + '    </div>'
      + '  </div>'
      + '  <div id="hc-uv-foot">'
      + '    <button class="hc-uv-btn primary" id="hc-uv-apply">\u5e94\u7528</button>'
      + '    <button class="hc-uv-btn" id="hc-uv-reset">\u6062\u590d\u9ed8\u8ba4</button>'
      + '    <span id="hc-uv-msg"></span>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(mask);
    panel = mask;
    canvas = document.getElementById('hc-uv-canvas');

    document.getElementById('hc-uv-close').addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', escClose);

    var mvSlider = document.getElementById('hc-uv-mv');
    var mhzSlider = document.getElementById('hc-uv-mhz');
    mvSlider.addEventListener('input', function () { setCap(parseInt(mvSlider.value, 10), 0); draw(); });
    mhzSlider.addEventListener('input', function () { capMhz = parseInt(mhzSlider.value, 10); draw(); });

    Array.prototype.forEach.call(document.querySelectorAll('.hc-uv-preset'), function (el) {
      el.addEventListener('click', function () { setCap(parseInt(el.getAttribute('data-p'), 10), 0); draw(); });
    });

    document.getElementById('hc-uv-apply').addEventListener('click', doApply);
    document.getElementById('hc-uv-reset').addEventListener('click', doReset);

    canvas.addEventListener('pointerdown', onCanvasDown);
    canvas.addEventListener('pointermove', onCanvasMove);
    window.addEventListener('pointerup', onCanvasUp);
    window.addEventListener('resize', onResize);

    /* 面板刚插入时布局还没稳定，等一帧再定画布尺寸 */
    requestAnimationFrame(function () { fitCanvas(); draw(); });

    reload();
  }

  function onResize() {
    if (!panel || panel.style.display === 'none') return;
    fitCanvas();
    draw();
  }

  function escClose(ev) { if (ev.key === 'Escape') close(); }

  function close() {
    if (!panel) return;
    panel.style.display = 'none';
    document.removeEventListener('keydown', escClose);
  }

  function msg(text, color) {
    var el = document.getElementById('hc-uv-msg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#8b93a7';
  }

  function reload() {
    api('/curve', 6000).then(function (data) {
      points = data.points || [];
      var gpuEl = document.getElementById('hc-uv-gpu');
      if (gpuEl) gpuEl.textContent = (data.gpu || '') + (data.admin ? '' : '\uff08\u9700\u7ba1\u7406\u5458\uff09');
      if (!points.length) { msg('\u66f2\u7ebf\u4e3a\u7a7a', '#ff8a8a'); return; }
      if (!capMhz) {
        var at = nearest(capMv);
        capMhz = at ? at.mhz : points[points.length - 1].mhz;
      }
      syncSliders();
      draw();
      msg('');
    }).catch(function (err) {
      msg('\u672a\u8fde\u63a5\u5230\u964d\u538b\u670d\u52a1\uff1a' + err.message, '#ff8a8a');
      points = [];
      draw();
    });
  }

  function nearest(mv) {
    var best = null, d = 1e9;
    for (var i = 0; i < points.length; i++) {
      var dd = Math.abs(points[i].mv - mv);
      if (dd < d) { d = dd; best = points[i]; }
    }
    return best;
  }

  function setCap(mv, mhz) {
    capMv = Math.max(700, Math.min(1250, mv));
    var at = nearest(capMv);
    if (mhz) capMhz = mhz;
    else if (at) capMhz = at.mhz;
    syncSliders();
  }

  function syncSliders() {
    var mvS = document.getElementById('hc-uv-mv');
    var mhzS = document.getElementById('hc-uv-mhz');
    var mvV = document.getElementById('hc-uv-mv-v');
    var mhzV = document.getElementById('hc-uv-mhz-v');
    if (!mvS) return;
    mvS.value = capMv;
    mhzS.value = capMhz;
    mvV.textContent = capMv + ' mV';
    mhzV.textContent = capMhz ? capMhz + ' MHz' : '--';
  }

  /* ---------- 绘制 ---------- */
  var PAD = { l: 44, r: 12, t: 14, b: 26 };
  var cw = 0, ch = 0, dpr = 1;

  /* 按 CSS 尺寸 × devicePixelRatio 设置画布后备分辨率，避免高分屏下发虚 */
  function fitCanvas() {
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var d = window.devicePixelRatio || 1;
    if (w === cw && h === ch && d === dpr && canvas.width) return;
    cw = w; ch = h; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  function sx(mv) { return PAD.l + (mv - 450) / (1280 - 450) * (cw - PAD.l - PAD.r); }
  function sy(mhz) { return ch - PAD.b - (mhz - 200) / (2900 - 200) * (ch - PAD.t - PAD.b); }
  function vx(x) { return 450 + (x - PAD.l) / (cw - PAD.l - PAD.r) * (1280 - 450); }
  function vy(y) { return 200 + (ch - PAD.b - y) / (ch - PAD.t - PAD.b) * (2900 - 200); }

  function draw() {
    if (!canvas) return;
    fitCanvas();
    var ctx = canvas.getContext('2d');
    var W = cw, H = ch;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    /* 网格 */
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.fillStyle = 'rgba(160,170,195,.75)';
    ctx.font = '11px "Microsoft YaHei",system-ui';
    ctx.lineWidth = 1;
    var mv;
    for (mv = 500; mv <= 1250; mv += 250) {
      var x = sx(mv);
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(mv + '', x, H - PAD.b + 15);
    }
    var mhz;
    for (mhz = 500; mhz <= 2500; mhz += 500) {
      var y = sy(mhz);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(mhz + '', PAD.l - 6, y + 4);
    }

    if (!points.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(160,170,195,.6)';
      ctx.fillText('\u6682\u65e0\u6570\u636e', W / 2, H / 2);
      return;
    }

    /* 降压后曲线：cap 以下保持，cap 以上拉平（先画，下面用虚线再叠当前曲线） */
    ctx.beginPath();
    for (var j = 0; j < points.length; j++) {
      if (points[j].mv > capMv) break;
      var qx = sx(points[j].mv), qy = sy(points[j].mhz);
      if (j === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
    }
    var cx = sx(capMv), cyv = sy(capMhz);
    ctx.lineTo(cx, cyv);
    ctx.lineTo(sx(1280), cyv);
    ctx.strokeStyle = '#ff4d6d';
    ctx.lineWidth = 2.4;
    ctx.shadowColor = 'rgba(255,77,109,.5)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    /* 当前曲线：虚线压在上面，方便看清降压后被削平的那一段 */
    ctx.beginPath();
    for (var k = 0; k < points.length; k++) {
      var ax = sx(points[k].mv), ay = sy(points[k].mhz);
      if (k === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
    }
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(111,214,196,.95)';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(111,214,196,.35)';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);

    /* 拖拽点 */
    ctx.beginPath();
    ctx.arc(cx, cyv, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ff4d6d';
    ctx.stroke();

    /* 提示框 */
    var tip = capMv + ' mV \u00b7 ' + (capMhz || '--') + ' MHz';
    ctx.font = '12px "Microsoft YaHei",system-ui';
    var tw = ctx.measureText(tip).width + 16;
    var bx = Math.min(Math.max(cx - tw / 2, PAD.l), W - PAD.r - tw);
    var by = Math.max(cyv - 34, PAD.t + 2);
    ctx.fillStyle = 'rgba(255,77,109,.92)';
    roundRect(ctx, bx, by, tw, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(tip, bx + tw / 2, by + 15);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------- 拖拽 ---------- */
  var dragging = false;
  function canvasPos(ev) {
    var r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function onCanvasDown(ev) { dragging = true; onCanvasMove(ev); ev.preventDefault(); }
  function onCanvasUp() { dragging = false; }
  function onCanvasMove(ev) {
    if (!dragging || !points.length) return;
    var p = canvasPos(ev);
    var mv = Math.round(vx(p.x) / 5) * 5;
    var mhz = Math.round(vy(p.y) / 5) * 5;
    capMv = Math.max(700, Math.min(1250, mv));
    capMhz = Math.max(1200, Math.min(2800, mhz));
    syncSliders();
    draw();
  }

  /* ---------- 操作 ---------- */
  function doApply() {
    if (busy) return;
    busy = true;
    var btn = document.getElementById('hc-uv-apply');
    btn.disabled = true;
    msg('\u5e94\u7528\u4e2d\u2026');
    api('/apply?mv=' + capMv + '&mhz=' + capMhz, 20000).then(function (data) {
      points = data.points || points;
      msg('\u5df2\u5e94\u7528\uff1a' + capMv + 'mV \u4ee5\u4e0a\u62c9\u5e73\u5230 ' + capMhz + 'MHz', '#6fd6c4');
      draw();
    }).catch(function (err) {
      msg('\u5e94\u7528\u5931\u8d25\uff1a' + err.message, '#ff8a8a');
    }).then(function () {
      busy = false;
      btn.disabled = false;
    });
  }

  function doReset() {
    if (busy) return;
    busy = true;
    var btn = document.getElementById('hc-uv-reset');
    btn.disabled = true;
    msg('\u6062\u590d\u4e2d\u2026');
    api('/clear', 20000).then(function (data) {
      points = data.points || points;
      msg('\u5df2\u6062\u590d\u9ed8\u8ba4\u9891\u7387', '#6fd6c4');
      draw();
    }).catch(function (err) {
      msg('\u6062\u590d\u5931\u8d25\uff1a' + err.message, '#ff8a8a');
    }).then(function () {
      busy = false;
      btn.disabled = false;
    });
  }

  /* ---------- 与「深度优化」联动：按下就应用当前降压设置，且之后不自动恢复 ---------- */
  var autoApplied = false;
  function setCardSub(text) {
    try {
      var card = document.querySelector('[data-hc-uv="1"]');
      if (!card) return;
      var label = card.querySelector('[class*="ModeCardItemBox_label"]');
      if (label) label.textContent = text;
    } catch (e) {}
  }

  function autoApply() {
    if (busy) return;
    if (!capMhz) {
      /* 还没读过曲线，先补一次，拿到与该电压对应的频率 */
      api('/curve', 6000).then(function (data) {
        points = data.points || points;
        if (points && points.length) {
          var at = nearest(capMv);
          capMhz = at ? at.mhz : points[points.length - 1].mhz;
        }
        autoApply();
      }).catch(function (err) { log('自动应用前读取曲线失败', err && err.message); });
      return;
    }
    busy = true;
    log('深度优化 → 自动应用降压', capMv, capMhz);
    api('/apply?mv=' + capMv + '&mhz=' + capMhz, 20000).then(function (data) {
      points = data.points || points;
      autoApplied = true;
      setCardSub('\u5df2\u964d\u538b ' + capMv + ' mV');
      if (panel) {
        draw();
        msg('\u5df2\u81ea\u52a8\u5e94\u7528\uff1a' + capMv + 'mV \u4ee5\u4e0a\u62c9\u5e73\u5230 ' + capMhz + 'MHz', '#6fd6c4');
      }
      log('自动应用成功');
    }).catch(function (err) {
      if (panel) msg('\u81ea\u52a8\u5e94\u7528\u5931\u8d25\uff1a' + err.message, '#ff8a8a');
      log('自动应用失败', err && err.message);
    }).then(function () { busy = false; });
  }

  /* ---------- 挂载 ---------- */
  function ensure() {
    try {
      if (!document.body) return;
      var list = findCards();
      if (!list.length) return;
      if (!document.querySelector('[data-hc-uv="1"]')) build();
      else fitRow();
    } catch (e) { log('ensure error', e && e.message); }
  }

  function boot() {
    injectCardStyle();
    /* 启动时探一次服务，服务端会记录一条 /ping，便于确认网页端能访问本机接口 */
    api('/ping', 4000).then(function (d) { log('服务在线', d && d.gpu); })
                     .catch(function (e) { log('服务不可用', e && e.message); });
    /* 首页「深度优化」被按下时，自动应用当前降压设置（由 huntercamp-homecard.js 派发） */
    document.addEventListener('hc-deep-start', function () {
      log('收到 hc-deep-start');
      autoApply();
    });
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      ensure();
      if (document.querySelector('[data-hc-uv="1"]') || tries > 40) clearInterval(timer);
    }, 500);
    try {
      var obs = new MutationObserver(function () { ensure(); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    log('显卡降压卡片已加载');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();


  window.__hcUv = {
    open: open,
    close: close,
    reload: reload,
    points: function () { return points; },
    setCap: setCap,
    autoApply: autoApply,
    applied: function () { return autoApplied; }
  };
})();
