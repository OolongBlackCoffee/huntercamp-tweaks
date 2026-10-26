/*
 * HUNTER CAMP 超频上限解除
 * 官方前端把「核心超频」限制在 200MHz、「显存超频」限制在 400MHz。
 * 本脚本把这两处理论上限各放大 3 倍：核心 600、显存 1200。
 *
 * 用法：
 *   node patch-oclimit.js "<安装目录>\build\static\js"            部署（幂等）
 *   node patch-oclimit.js "<安装目录>\build\static\js" --restore   还原
 *
 * 只动含“不锁频超频”输入框的那几个 chunk，原文件备份为 *.orig-oclimit。
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const restore = process.argv.includes('--restore');
if (!dir || !fs.existsSync(dir)) {
  console.error('目录不存在: ' + dir);
  process.exit(2);
}

const CORE = /CustomOptimizationDetail\.gpuForOverclocking(?!Tips)/g;
const MEM = /CustomOptimizationDetail\.vramOverclocking(?!Tips)/g;
const WIN = 900;

function patchWindow(s, start, from, to) {
  const end = Math.min(s.length, start + WIN);
  let seg = s.slice(start, end);
  let n = 0;
  const rep = (a, b) => {
    const parts = seg.split(a);
    if (parts.length > 1) { n += parts.length - 1; seg = parts.join(b); }
  };
  rep('max:' + from, 'max:' + to);
  rep('placeholder:"0-' + from + '"', 'placeholder:"0-' + to + '"');
  rep(',' + from + ')', ',' + to + ')');
  rep('[0,' + from + ']', '[0,' + to + ']');
  rep('[' + from + ']', '[' + to + ']');
  rep('[' + from + ',', '[' + to + ',');
  rep(', ' + from + ']', ', ' + to + ']');
  return { seg, n };
}

function patchPass(src, re, from, to) {
  let out = '';
  let i = 0;
  let n = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const at = m.index + m[0].length;
    if (at <= i) continue;
    out += src.slice(i, at);
    const w = patchWindow(src, at, from, to);
    out += w.seg;
    n += w.n;
    i = Math.min(src.length, at + WIN);
  }
  out += src.slice(i);
  return { text: out, n };
}

function patchText(src) {
  const core = patchPass(src, CORE, 200, 600);
  const mem = patchPass(core.text, MEM, 400, 1200);
  return { text: mem.text, n: core.n + mem.n };
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
let touched = 0, totalRep = 0, restored = 0;

for (const f of files) {
  const full = path.join(dir, f);
  const bak = full + '.orig-oclimit';

  if (restore) {
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, full);
      console.log('  已还原 ' + f);
      restored++;
    }
    continue;
  }

  const src = fs.readFileSync(full, 'utf8');
  if (!CORE.test(src) && !MEM.test(src)) { CORE.lastIndex = 0; MEM.lastIndex = 0; continue; }
  CORE.lastIndex = 0; MEM.lastIndex = 0;
  if (src.includes('max:600') || src.includes('max:1200')) {
    console.log('  [跳过] ' + f + ' 已是修改后版本');
    continue;
  }
  const r = patchText(src);
  if (r.n === 0) continue;
  if (!fs.existsSync(bak)) fs.copyFileSync(full, bak);
  fs.writeFileSync(full, r.text, 'utf8');
  console.log('  [修改] ' + f + ' 替换 ' + r.n + ' 处');
  touched++; totalRep += r.n;
}

if (restore) {
  console.log(restored ? ('还原完成：' + restored + ' 个文件') : '没有需要还原的文件（或未部署过）');
} else {
  console.log(touched ? ('超频上限已解除：' + touched + ' 个文件，共 ' + totalRep + ' 处') : '没有找到需要修改的文件（可能已改过，或版本结构变了）');
}
