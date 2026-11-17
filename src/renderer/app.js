'use strict';
(function () {
/* =========================================================
   LaunchPlay 影音快启 渲染进程
   - 空间导航焦点系统(方向键/遥控器/手柄通用)
   - 磁贴渲染、启动、添加/编辑/移除
   - 设置、电源确认、开机自启
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const api = window.api;

/* ------------------------- 状态 ------------------------- */
const state = {
  items: [],
  settings: {
    autostart: false, fullscreen: true, sound: true,
    tileSize: 'normal', hideHints: false,
    background: { file: 'default', dim: 0.25, blur: false },
  },
  firstRun: true,
  dataDir: '',
  version: '',
  focusId: '',
  isFullscreen: true,
  suppressLaunchUntil: 0, // 拖动排序结束后短暂屏蔽点击, 避免"松手就启动"
};

const overlayEl = () => $('#overlay');
const isOverlayOpen = () => !overlayEl().classList.contains('hidden');

/**
 * 平台信息（init 时由主进程灌进来）。
 * 文案与可选项都从这里取，模板里就不用再写三元表达式判断系统。
 */
let PLAT = {
  win: true,
  mac: false,
  linux: false,
  caps: { windowBoost: true, elevate: true, uwp: true },
  text: {
    osName: 'Windows',
    loginHint: '登录 Windows 后自动打开启动台',
    pickerHint: '点击右侧「浏览…」选择 exe、bat 或快捷方式',
    pathPlaceholder: 'C:\\Program Files\\App\\app.exe',
    formatHelp: '支持 exe / lnk / bat / cmd 等格式。',
    quitHint: '关闭程序，返回 Windows 桌面',
  },
};

/**
 * 只有"鼠标真的在动"时才让悬停接管焦点。
 * 否则弹层刚打开时光标恰好压在某个元素上, 会莫名其妙把焦点抢走。
 */
let pointerMovedAt = 0;
document.addEventListener('mousemove', () => { pointerMovedAt = Date.now(); }, { passive: true });
function hoverFocus(el) {
  if (drag && drag.active) return; // 拖动中别抢焦点
  if (Date.now() - pointerMovedAt < 600) Focus.set(el, { noScroll: true });
}

/* ------------------------- 工具 ------------------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return h;
}
function uid() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function fileFromUrl(u) {
  try { return decodeURIComponent(String(u).split('/').pop()); } catch { return ''; }
}
function urlFromFile(f) {
  return f ? 'tlapp://icon/' + encodeURIComponent(f) : '';
}
function clampText(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/* ------------------------- 音效 ------------------------- */
let audioCtx = null;
function beep(freq, dur = 0.09, gain = 0.03) {
  if (!state.settings.sound) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch { /* 无声环境忽略 */ }
}
const tick = () => beep(520, 0.06, 0.022);
const confirmSound = () => beep(760, 0.1, 0.032);

/* ------------------------- Toast ------------------------- */
function toast(msg, type = 'ok', ms = 2000) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' err' : '');
  el.innerHTML = `<span class="dot"></span><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
  // 最多保留 3 条
  while (wrap.children.length > 3) wrap.firstElementChild.remove();
}

/* ------------------------- 焦点系统 ------------------------- */
const Focus = {
  el: null,

  zoneOf(el) {
    if (!el) return 'grid';
    if (el.closest('#overlay')) return 'modal';
    if (el.closest('.topbar')) return 'header';
    return 'grid';
  },

  visible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  },

  set(el, opts = {}) {
    if (!el) return;
    if (el === this.el) {
      if (!opts.noScroll) this.scrollTo(el, opts.instant);
      return;
    }
    if (this.el) this.el.classList.remove('focused');
    this.el = el;
    el.classList.add('focused');
    if (el.dataset && el.dataset.id) state.focusId = el.dataset.id;
    // 输入框需要真正的原生焦点才能打字, 这里保持"视觉焦点 = 真实焦点"
    if (el.tagName === 'INPUT' && document.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    }
    if (!opts.noScroll) this.scrollTo(el, opts.instant);
  },

  scrollTo(el, instant) {
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: instant ? 'auto' : 'smooth' });
    } catch { /* ignore */ }
  },

  /** 同区域内的方向最近邻 */
  spatial(dir, list, from) {
    const el = from || this.el;
    if (!el) return null;
    const cr = el.getBoundingClientRect();
    if (!cr.width) return null;
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const cand of list) {
      if (cand === el || !this.visible(cand)) continue;
      const r = cand.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const dx = x - cx;
      const dy = y - cy;
      let primary, secondary;
      if (dir === 'left') { if (dx > -4) continue; primary = -dx; secondary = Math.abs(dy); }
      else if (dir === 'right') { if (dx < 4) continue; primary = dx; secondary = Math.abs(dy); }
      else if (dir === 'up') { if (dy > -4) continue; primary = -dy; secondary = Math.abs(dx); }
      else { if (dy < 4) continue; primary = dy; secondary = Math.abs(dx); }
      const score = primary + secondary * 2.6;
      if (score < bestScore) { bestScore = score; best = cand; }
    }
    return best;
  },

  gridTiles() { return $$('#grid [data-focusable]'); },
  headerBtns() { return $$('.topbar [data-focusable]'); },
  modalItems() { return $$('#modal [data-focusable]'); },

  /** 按水平距离找最近元素, 可限制同一行 */
  nearestByX(list, from, topRowOnly) {
    const el = from || this.el;
    if (!el) return list[0] || null;
    const cr = el.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    let pool = list.filter((c) => this.visible(c));
    if (topRowOnly && pool.length) {
      const minTop = Math.min(...pool.map((c) => c.getBoundingClientRect().top));
      pool = pool.filter((c) => Math.abs(c.getBoundingClientRect().top - minTop) < 8);
    }
    let best = null;
    let bd = Infinity;
    for (const c of pool) {
      const r = c.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - cx);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  },

  move(dir) {
    if (!this.el) {
      const first = this.gridTiles()[0] || this.headerBtns()[0];
      if (first) this.set(first, { instant: true });
      return false;
    }
    const zone = this.zoneOf(this.el);

    if (zone === 'modal') {
      const next = this.spatial(dir, this.modalItems());
      if (next) { this.set(next); tick(); return true; }
      return false;
    }

    if (zone === 'header') {
      if (dir === 'down') {
        const t = this.nearestByX(this.gridTiles(), this.el, true);
        if (t) { this.set(t); tick(); return true; }
        return false;
      }
      if (dir === 'up') return false;
      const next = this.spatial(dir, this.headerBtns());
      if (next) { this.set(next); tick(); return true; }
      return false;
    }

    // grid
    const next = this.spatial(dir, this.gridTiles());
    if (next) { this.set(next); tick(); return true; }
    if (dir === 'up') {
      const h = this.nearestByX(this.headerBtns(), this.el, false);
      if (h) { this.set(h); tick(); return true; }
    }
    return false;
  },

  firstInGrid() {
    const tiles = this.gridTiles();
    if (!tiles.length) return null;
    return tiles.find((t) => t.dataset.id === state.focusId) || tiles[0];
  },
};
window.__focus = Focus; // 便于调试

/* ------------------------- 时钟 ------------------------- */
const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function updateClock() {
  const d = new Date();
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const el = $('#clock');
  if (el.textContent !== t) el.textContent = t;
  const dt = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
  const de = $('#date');
  if (de.textContent !== dt) de.textContent = dt;
}

/* ------------------------- 设置应用 ------------------------- */
/** 背景暗度档位: 0 原图 / 越暗文字越清楚 */
const BG_DIM_STEPS = [0, 0.25, 0.45, 0.65];

/** 内置壁纸: 空字符串表示"纯深色渐变", 'default' 表示随程序发布的那张图 */
const DEFAULT_BG_FILE = 'default';
const DEFAULT_BG_URL = 'assets/bg-default.jpg';

function bgSettings() {
  const b = state.settings.background || {};
  return {
    file: b.file || '',
    dim: typeof b.dim === 'number' ? b.dim : 0.45,
    blur: !!b.blur,
  };
}

function bgUrlOf(file) {
  if (!file) return '';
  if (file === DEFAULT_BG_FILE) return DEFAULT_BG_URL;
  return `tlapp://bg/${encodeURIComponent(file)}`;
}

function applyBackground() {
  const bg = bgSettings();
  const photo = $('#bgPhoto');
  const scrim = $('#bgScrim');
  if (!photo || !scrim) return;
  const on = !!bg.file;

  if (on) {
    const url = bgUrlOf(bg.file);
    photo.style.backgroundImage = `url("${url}")`;
    photo.classList.add('on');
    document.body.classList.add('has-bg');

    // 图片被手动删掉/损坏时, 别留一层压暗的黑罩 —— 自动退回内置壁纸
    const probe = new Image();
    probe.onerror = () => {
      if (bgSettings().file !== bg.file) return;
      state.settings.background = {
        ...bgSettings(),
        file: bg.file === DEFAULT_BG_FILE ? '' : DEFAULT_BG_FILE,
      };
      applyBackground();
      persist();
    };
    probe.src = url;
  } else {
    photo.classList.remove('on');
    document.body.classList.remove('has-bg');
    // 等淡出动画结束再清掉, 避免图片"闪一下"
    setTimeout(() => { if (!bgSettings().file) photo.style.backgroundImage = ''; }, 620);
  }
  photo.classList.toggle('blur', on && bg.blur);
  scrim.style.display = on ? '' : 'none';
  document.documentElement.style.setProperty('--bg-dim', String(bg.dim));
}

function applySettings() {
  const s = state.settings;
  document.documentElement.dataset.size = s.tileSize || 'normal';
  $('#hintbar').classList.toggle('hide', !!s.hideHints);
  state.isFullscreen = s.fullscreen !== false;
  applyBackground();
}

/* ------------------------- 渲染 ------------------------- */
function letterTile(name) {
  const d = document.createElement('div');
  d.className = 'letter';
  const h = hashStr(name || '?') % 360;
  d.style.background = `linear-gradient(150deg, hsl(${h} 62% 48%), hsl(${(h + 42) % 360} 58% 33%))`;
  d.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return d;
}

/* ------------------------- 拖动排序 ------------------------- */
/**
 * 磁贴拖动换位: 按下不动就是普通点击(启动), 移动超过 8px 才进入拖动。
 * 拖动过程中直接调整 DOM 顺序(拖到哪个磁贴的左/右半边就插到那一侧),
 * 松手后把 DOM 顺序写回 state.items 并落盘。
 */
let drag = null;

function tileAtPoint(x, y) {
  const hit = document.elementFromPoint(x, y);
  const t = hit && hit.closest ? hit.closest('#grid .tile') : null;
  return t && t !== drag.el ? t : null;
}

function onDragMove(ev) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 8) return;
    drag.active = true;
    drag.el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    // 让 elementFromPoint 能"看穿"正在拖的那块磁贴
    drag.el.style.pointerEvents = 'none';
  }
  ev.preventDefault();

  const over = tileAtPoint(ev.clientX, ev.clientY);
  if (over) {
    const r = over.getBoundingClientRect();
    const toLeft = ev.clientX < r.left + r.width / 2;
    const ref = toLeft ? over : over.nextSibling;
    if (ref !== drag.el) drag.el.parentNode.insertBefore(drag.el, ref); // 已在该位置时 ref 就是自己
    return;
  }

  // 拖到磁贴外的空白区域: 上半部分插到最前, 其余落到最后
  const grid = $('#grid');
  const stage = $('#stage').getBoundingClientRect();
  const { clientX: x, clientY: y } = ev;
  if (x < stage.left || x > stage.right || y < stage.top || y > stage.bottom) return;
  if (grid.children.length < 2) return;

  const head = grid.firstElementChild === drag.el ? drag.el.nextElementSibling : grid.firstElementChild;
  if (!head) return;
  if (y < head.getBoundingClientRect().top) {
    if (grid.firstElementChild !== drag.el) grid.insertBefore(drag.el, grid.firstElementChild);
  } else if (grid.lastElementChild !== drag.el) {
    grid.appendChild(drag.el);
  }
}

function endDrag() {
  const d = drag;
  drag = null;
  window.removeEventListener('pointermove', onDragMove, true);
  window.removeEventListener('pointerup', endDrag, true);
  window.removeEventListener('pointercancel', endDrag, true);
  if (!d) return;

  document.body.classList.remove('is-dragging');
  d.el.classList.remove('dragging');
  d.el.style.pointerEvents = '';
  if (!d.active) return;

  // 松手后紧跟的那次 click 不能再当成"启动"
  state.suppressLaunchUntil = Date.now() + 350;

  const ids = $$('#grid .tile').map((el) => el.dataset.id);
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  if (next.length === state.items.length) state.items = next;
  state.focusId = d.id;
  persist();
  renderGrid();
  confirmSound();
}

function beginDrag(el, item, ev) {
  if (ev.button !== 0 || state.items.length < 2) return;
  drag = { el, id: item.id, x: ev.clientX, y: ev.clientY, active: false };
  window.addEventListener('pointermove', onDragMove, true);
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', endDrag, true);
}

/* ------------------------- 磁贴 ------------------------- */
function makeTile(item) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.focusable = '';
  el.dataset.id = item.id;
  el.setAttribute('role', 'button');
  el.title = item.target || item.appId || item.name;

  const wrap = document.createElement('div');
  wrap.className = 'tile-icon';
  if (item.iconFile) {
    const img = document.createElement('img');
    img.src = urlFromFile(item.iconFile);
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => {
      wrap.replaceChildren(letterTile(item.name));
    }, { once: true });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(letterTile(item.name));
  }

  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = item.name;

  el.append(wrap, name);
  // 鼠标按下就把焦点移过来 —— 点开的那个磁贴必须保持高亮,
  // 否则高亮还停在键盘选中的旧磁贴上, 看起来像"没选中就打开了"
  el.addEventListener('pointerdown', (ev) => {
    Focus.set(el, { noScroll: true });
    beginDrag(el, item, ev);
  });
  el.addEventListener('mouseenter', () => hoverFocus(el));
  el.addEventListener('click', () => launchItem(item));
  el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openEdit(item); });
  return el;
}

function renderGrid() {
  const grid = $('#grid');
  const frag = document.createDocumentFragment();
  for (const item of state.items) frag.appendChild(makeTile(item));
  grid.replaceChildren(frag);

  $('#welcome').classList.toggle('show', state.items.length === 0);

  // 恢复焦点
  const target = grid.querySelector(`[data-id="${state.focusId}"]`) || grid.firstElementChild;
  if (target) Focus.set(target, { instant: true, noScroll: false });
}

/* ------------------------- 启动 / 电源 ------------------------- */
async function launchItem(item) {
  if (!item) return;
  // 拖动排序松手后会有一次"顺手"的 click, 不能当成启动
  if (Date.now() < (state.suppressLaunchUntil || 0)) return;
  // 兜底: 不管从哪条路径触发启动, 都让被启动的磁贴保持高亮
  const tile = $(`#grid [data-id="${item.id}"]`);
  if (tile && Focus.el !== tile) Focus.set(tile, { noScroll: true });
  confirmSound();
  const t = toast(`正在启动 · ${item.name}`, 'ok', 1600);
  const r = await api.launch(item);
  if (!r || !r.ok) toast(r && r.error ? r.error : '启动失败', 'err', 3600);
  else setTimeout(() => t.remove(), 900);
}

function askPower(kind) {
  const isRestart = kind === 'restart';
  openModal(`
    <div class="m-body" style="padding-top:26px">
      <div class="confirm-icon ${isRestart ? 'is-restart' : 'is-off'}">
        <img src="${isRestart ? 'assets/power-restart.png' : 'assets/power-off.png'}" alt="" />
      </div>
      <div class="confirm-title">${isRestart ? '确认重启计算机？' : '确认关机？'}</div>
      <div class="confirm-sub">
        ${isRestart ? '正在运行的程序会被关闭，未保存的内容可能丢失。' : '计算机会立即关闭，请先保存正在进行的工作。'}
      </div>
    </div>
    <div class="m-foot" style="justify-content:center">
      <button class="btn" data-action="cancel" data-focusable>取消 <span style="opacity:.5">(Esc)</span></button>
      <button class="btn ${isRestart ? 'btn-primary' : 'btn-danger'}" data-action="go" data-focusable>
        ${isRestart ? '立即重启' : '立即关机'}
      </button>
    </div>
  `, { tiny: true, autofocus: '[data-action="go"]' });

  $('#modal').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'cancel') { closeModal(); return; }
    confirmSound();
    closeModal();
    const r = await api.power(kind);
    if (!r || !r.ok) toast('操作失败: ' + (r && r.error || '未知错误'), 'err', 3600);
    else toast(isRestart ? '正在重启…' : '正在关机…', 'ok', 3000);
  });
}

/* ------------------------- 弹层基础 ------------------------- */
let modalEscHandler = null;

function openModal(html, opts = {}) {
  // 每次都重建节点: 彻底避免上一轮绑定的事件监听残留(否则会出现"关机会连着重启"之类的串味问题)
  const old = document.getElementById('modal');
  const modal = document.createElement('div');
  modal.id = 'modal';
  modal.className = 'modal' + (opts.narrow ? ' narrow' : '') + (opts.tiny ? ' tiny' : '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = html;
  if (old && old.parentNode) old.replaceWith(modal);
  else overlayEl().appendChild(modal);

  overlayEl().classList.remove('hidden');
  // 打开弹层前把旧的视觉焦点清掉: 否则弹层背后的磁贴/按钮会一直亮着,
  // 弹层里又有另一个高亮, 看起来像"同时选中了两个"
  if (Focus.el) Focus.el.classList.remove('focused');
  Focus.el = null;
  modalEscHandler = opts.onEsc || null;

  const sel = opts.autofocus;
  let target = sel ? modal.querySelector(sel) : null;
  if (!target) target = modal.querySelector('[data-autofocus]');
  if (!target) target = modal.querySelector('[data-focusable]');
  if (target) Focus.set(target, { instant: true });
  return modal;
}

function closeModal() {
  overlayEl().classList.add('hidden');
  $('#modal').innerHTML = '';
  modalEscHandler = null;
  Focus.el = null;
  const tiles = Focus.gridTiles();
  const back = tiles.find((t) => t.dataset.id === state.focusId) || tiles[0] || $('#btnAdd');
  if (back) Focus.set(back, { instant: true });
}

/** 通用: 绑定 data-close */
function bindClose() {
  $$('#modal [data-close]').forEach((b) => b.addEventListener('click', closeModal));
}

/* =========================================================
   添加应用（手动指定程序）
   ========================================================= */
async function openAdd() {
  const modal = openModal(`
    <div class="m-head">
      <div>
        <div class="m-title">添加应用</div>
        <div class="m-sub">选择一个程序文件（支持多选），它会以磁贴形式出现在启动台上</div>
      </div>
      <button class="btn btn-icon-only" data-close data-focusable title="关闭">✕</button>
    </div>
    <div class="m-body" id="addBody">
      <div class="field">
        <label class="field-label">程序路径 / 快捷方式</label>
        <div class="input-row">
          <input class="input" id="fPath" data-focusable placeholder="${esc(PLAT.text.pickerHint)}" />
          <button class="btn btn-primary" id="fBrowse" data-focusable>浏览…</button>
        </div>
      </div>
      <div class="field">
        <label class="field-label">显示名称</label>
        <input class="input" id="fName" data-focusable placeholder="默认取自文件名，可自行修改" />
      </div>
      <div class="field">
        <label class="field-label">启动参数（可选）</label>
        <input class="input" id="fArgs" data-focusable placeholder="例如 --fullscreen" />
      </div>
      <div class="field">
        <label class="field-label">自定义图标（可选，留空自动提取程序图标）</label>
        <div class="input-row">
          <input class="input" id="fIconLabel" data-focusable readonly value="自动" />
          <button class="btn" id="fPickIcon" data-focusable>选择图片</button>
        </div>
      </div>
      <div class="icon-preview-wrap" id="iconPreviewWrap"></div>
      <div class="tip-box">
        ${esc(PLAT.text.formatHelp)}
      </div>
    </div>
    <div class="m-foot">
      <div class="foot-hint">
        <span><kbd>Tab</kbd> 切换输入项</span>
        <span><kbd>Enter</kbd> 添加</span>
        <span><kbd>Esc</kbd> 取消</span>
      </div>
      <button class="btn" data-close data-focusable>取消</button>
      <button class="btn btn-primary" id="aSave" data-focusable>添加到启动台</button>
    </div>
  `, { narrow: true, autofocus: '#fBrowse' });

  bindClose();
  const body = $('#addBody', modal);
  const $path = $('#fPath', body);
  const $name = $('#fName', body);
  const $args = $('#fArgs', body);
  const $iconLabel = $('#fIconLabel', body);
  let iconFile = '';
  // 选择窗口解析 .lnk 得到的图标位置。换电脑后目标 exe 常常找不到,
  // 但快捷方式里记录的 IconLocation 仍然有效, 不能像以前那样丢掉。
  let pickedIconPath = '';
  let pickedWarning = '';

  async function refreshPreview() {
    const wrap = $('#iconPreviewWrap', body);
    if (!wrap) return;
    const p = ($path.value || '').trim();
    if (!p) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<span class="dim">正在提取图标…</span>';
    let url = '';
    try {
      const map = await api.ensureIcons([{
        id: 'preview', kind: 'exe', target: p,
        iconPath: pickedIconPath || p, appId: '', name: '',
      }]);
      url = (map && map.preview) || '';
    } catch { url = ''; }
    wrap.innerHTML = url
      ? `<img src="${esc(url)}" alt="" /><span>已从程序中提取到图标</span>`
      : '<span class="dim">未能提取到图标，将使用程序名首字母占位</span>';
  }

  $('#fBrowse', body).addEventListener('click', async () => {
    let files = null;
    try { files = await api.pickExe(); } catch (e) { toast('打开选择窗口失败: ' + e.message, 'err'); return; }
    if (!files || !files.length) return;

    if (files.length === 1) {
      const f = files[0];
      $path.value = f.path || '';
      pickedIconPath = f.iconPath || '';
      pickedWarning = f.warning || '';
      if (!$name.value.trim()) $name.value = f.name || '';
      if (f.args) $args.value = f.args;
      refreshPreview();
      if (pickedWarning) toast(pickedWarning, 'err', 4200);
      Focus.set($('#aSave', modal), { noScroll: true });
      return;
    }

    // 多选: 一次性全部加入
    const n = await addMany(files);
    if (n > 0) { closeModal(); toast(`已添加 ${n} 个应用`, 'ok', 1800); }
    else toast('所选程序都已在启动台中', 'ok', 2000);
  });

  $('#fPickIcon', body).addEventListener('click', async () => {
    const p = await api.pickImage();
    if (!p) return;
    const url = await api.importIcon(p);
    if (!url) { toast('该图片无法用作图标', 'err'); return; }
    iconFile = fileFromUrl(url);
    $iconLabel.value = '已自定义';
    const wrap = $('#iconPreviewWrap', body);
    if (wrap) wrap.innerHTML = `<img src="${esc(url)}" alt="" /><span>使用自定义图片作为图标</span>`;
  });

  $path.addEventListener('blur', refreshPreview);
  // 手动改路径后, 之前那个快捷方式的 IconLocation 就不该再跟着用了
  $path.addEventListener('input', () => { pickedIconPath = ''; pickedWarning = ''; });

  // 输入框内按 Enter 直接提交
  [$path, $name, $args].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  });

  $('#aSave', modal).addEventListener('click', submit);

  async function submit() {
    const p = ($path.value || '').trim();
    const nm = ($name.value || '').trim();
    const ar = ($args.value || '').trim();
    if (!p) { toast('请先选择程序文件', 'err'); Focus.set($('#fBrowse', body)); return; }
    const name = nm || p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    if (!name) { toast('请填写显示名称', 'err'); Focus.set($name); return; }
    if (state.items.some((i) => (i.target || '').toLowerCase() === p.toLowerCase())) {
      toast('该程序已在启动台中', 'err', 2200);
      return;
    }
    closeModal();
    await addApp({
      name, target: p, args: ar, kind: 'exe',
      iconPath: pickedIconPath || p, iconFile, iconCustom: !!iconFile,
    });
    if (pickedWarning) toast(pickedWarning, 'err', 4200);
    toast(`已添加 · ${name}`, 'ok', 1600);
  }

  setTimeout(() => refreshPreviewIfFilled(), 60);
  function refreshPreviewIfFilled() {
    if (($path.value || '').trim()) refreshPreview();
  }
}

/* ------------------- 手动添加 / 编辑 ------------------- */
function fieldHtml(v = {}, isEdit = false) {
  return `
    <div class="field">
      <label class="field-label">显示名称</label>
      <input class="input" id="fName" data-focusable value="${esc(v.name || '')}" placeholder="例如 Visual Studio Code" />
    </div>
    <div class="field">
      <label class="field-label">程序路径 / 快捷方式</label>
      <div class="input-row">
        <input class="input" id="fPath" data-focusable value="${esc(v.target || '')}" placeholder="${esc(PLAT.text.pathPlaceholder)}" />
        <button class="btn" id="fBrowse" data-focusable>浏览…</button>
      </div>
    </div>
    <div class="field">
      <label class="field-label">启动参数（可选）</label>
      <input class="input" id="fArgs" data-focusable value="${esc(v.args || '')}" placeholder="--fullscreen" />
    </div>
    <div class="field">
      <label class="field-label">自定义图标（可选，留空则自动提取程序图标）</label>
      <div class="input-row">
        <input class="input" id="fIcon" data-focusable readonly value="${esc(v.iconLabel || '自动')}" placeholder="自动提取" />
        <button class="btn" id="fPickIcon" data-focusable>选择图片</button>
        ${isEdit ? '<button class="btn" id="fResetIcon" data-focusable>还原</button>' : ''}
      </div>
    </div>`;
}

function renderManualTab(body) {
  const tips = PLAT.win
    ? [
      '支持 exe / lnk / bat / cmd 以及任意协议路径',
      '选择 .lnk 快捷方式会自动解析出真实程序路径',
      '需要管理员权限的程序，启动时可能弹出 UAC 授权',
    ]
    : PLAT.mac
      ? [
        '支持 .app 应用包与任意可执行文件',
        '选中 .app 会自动读出应用名与包内图标',
        '未签名的应用首次启动时，需在「系统设置 → 隐私与安全性」里放行',
      ]
      : [
        '支持可执行文件、AppImage 与 .desktop 启动项',
        '选中 .desktop 会自动解析出真实命令与图标',
        'AppImage 会自动补上执行权限，不需要手动 chmod',
      ];

  body.innerHTML = `${fieldHtml({})}
    <div class="section-label" style="padding-left:0;margin-top:6px">提示</div>
    <div style="font-size:12px;color:var(--txt-dim);line-height:1.7;padding:0 2px 6px">
      ${tips.map((t) => `· ${esc(t)}`).join('<br/>')}
    </div>`;

  bindFieldEvents(body, null);
}

function bindFieldEvents(body, editing) {
  const $name = $('#fName', body);
  const $path = $('#fPath', body);
  const $browse = $('#fBrowse', body);
  const $pick = $('#fPickIcon', body);
  const $icon = $('#fIcon', body);
  const $reset = $('#fResetIcon', body);

  let iconFile = editing ? (editing.iconFile || '') : '';
  let iconLabel = editing ? (editing.iconCustom ? '已自定义' : '自动提取') : '自动';
  let iconChanged = false;   // 用户是否手动改过图标

  if ($browse) {
    $browse.addEventListener('click', async () => {
      const r = await api.pickExe();
      // pickExe 返回数组(支持多选), 编辑面板只取第一个
      const f = Array.isArray(r) ? r[0] : r;
      if (!f) return;
      if ($path) $path.value = f.path || '';
      if ($name && !$name.value.trim()) $name.value = f.name || '';
      if (!iconFile && $icon) { iconLabel = '自动'; $icon.value = '自动提取'; }
      if (f.path) Focus.set($path || $browse, { noScroll: true });
    });
  }

  if ($pick) {
    $pick.addEventListener('click', async () => {
      const p = await api.pickImage();
      if (!p) return;
      const url = await api.importIcon(p);
      if (!url) { toast('该图片无法用作图标', 'err'); return; }
      iconFile = fileFromUrl(url);
      iconLabel = '已自定义';
      iconChanged = true;
      if ($icon) $icon.value = '已自定义（自定义图片）';
      toast('图标已设置', 'ok', 1200);
    });
  }

  if ($reset) {
    $reset.addEventListener('click', () => {
      iconFile = '';
      iconLabel = '自动提取';
      iconChanged = true;
      if ($icon) $icon.value = '自动提取';
      toast('已还原为自动提取', 'ok', 1200);
    });
  }

  // 记录到 body 上, 供提交时读取
  body._getIcon = () => ({ iconFile, iconLabel, changed: iconChanged });
  if ($name) setTimeout(() => $name.focus(), 60);
}

function openEdit(item) {
  if (!item) return;
  openModal(`
    <div class="m-head">
      <div>
        <div class="m-title">编辑应用</div>
        <div class="m-sub">修改名称、路径或图标，改动会立即保存</div>
      </div>
      <button class="btn btn-icon-only" data-close data-focusable title="关闭">✕</button>
    </div>
    <div class="m-body" id="editBody">${fieldHtml({
      name: item.name, target: item.target || (item.kind === 'uwp' ? `shell:AppsFolder\\${item.appId}` : ''),
      args: item.args, iconFile: item.iconFile,
      iconLabel: item.iconCustom ? '已自定义' : '自动提取',
      iconCustom: item.iconCustom,
    }, true)}</div>
    <div class="m-foot">
      <button class="btn btn-danger" id="eDelete" data-focusable>从此启动台移除</button>
      <div style="flex:1 1 auto"></div>
      <button class="btn" data-close data-focusable>取消</button>
      <button class="btn btn-primary" id="eSave" data-focusable>保存</button>
    </div>
  `, { narrow: true, autofocus: '#eSave' });

  bindClose();
  const body = $('#editBody');
  bindFieldEvents(body, item);

  $('#eDelete').addEventListener('click', async () => {
    state.items = state.items.filter((i) => i.id !== item.id);
    await persist();
    renderGrid();
    closeModal();
    toast(`已移除 · ${item.name}`, 'ok', 1600);
  });

  $('#eSave').addEventListener('click', async () => {
    const name = ($('#fName', body).value || '').trim();
    const target = ($('#fPath', body).value || '').trim();
    const args = ($('#fArgs', body).value || '').trim();
    const { iconFile: newIcon, changed: iconChangedNow } = body._getIcon();
    if (!name) { toast('请填写显示名称', 'err'); Focus.set($('#fName', body)); return; }
    if (!target && item.kind !== 'uwp') { toast('请填写程序路径', 'err'); Focus.set($('#fPath', body)); return; }

    const it = state.items.find((i) => i.id === item.id);
    if (!it) { closeModal(); return; }
    it.name = name;
    it.args = args;
    // 自定义图片优先; 否则按当前路径重新提取(有缓存, 几乎零成本), 保证图标与路径一致
    if (iconChangedNow && newIcon) {
      it.iconFile = newIcon;
      it.iconCustom = true;
    } else {
      it.iconCustom = false;
      it.iconFile = '';
      try {
        const map = await api.ensureIcons([{
          id: it.id, kind: it.kind, target: it.target,
          iconPath: it.target, appId: it.appId, name: it.name,
        }]);
        if (map && map[it.id]) it.iconFile = fileFromUrl(map[it.id]);
      } catch { /* 无图标则用首字母占位 */ }
    }
    if (item.kind === 'uwp') {
      if (target && target.startsWith('shell:')) { /* 保持 appId 不变 */ } else if (target) {
        it.kind = 'exe';
        it.target = target;
        it.appId = '';
      }
    } else {
      it.target = target;
    }
    await persist();
    renderGrid();
    closeModal();
    toast('已保存', 'ok', 1400);
  });
}

/* =========================================================
   设置
   ========================================================= */
async function openSettings() {
  const s = state.settings;
  const bg = bgSettings();
  openModal(`
    <div class="m-head">
      <div>
        <div class="m-title">设置</div>
        <div class="m-sub">所有设置保存在本地，重启后依然生效</div>
      </div>
      <button class="btn btn-icon-only" data-close data-focusable title="关闭">✕</button>
    </div>
    <div class="m-body">
      <div class="setting" data-focusable data-toggle="autostart" data-autofocus>
        <div class="setting-text">
          <div class="setting-name">开机自启</div>
          <div class="setting-desc">${esc(PLAT.text.loginHint)}</div>
        </div>
        <div class="switch ${s.autostart ? 'on' : ''}"></div>
      </div>
      <div class="setting" data-focusable data-toggle="fullscreen">
        <div class="setting-text">
          <div class="setting-name">全屏沉浸显示</div>
          <div class="setting-desc">关闭后以窗口模式运行（F11 可随时切换）</div>
        </div>
        <div class="switch ${s.fullscreen !== false ? 'on' : ''}"></div>
      </div>
      <div class="setting" data-focusable data-toggle="hideAfterLaunch">
        <div class="setting-text">
          <div class="setting-name">启动后收起启动台</div>
          <div class="setting-desc">关闭时（默认）启动台留在应用下层，开启则完全隐藏</div>
        </div>
        <div class="switch ${s.hideAfterLaunch !== false ? 'on' : ''}"></div>
      </div>
      ${PLAT.caps.windowBoost ? `<div class="setting" data-focusable data-toggle="boostLaunch">
        <div class="setting-text">
          <div class="setting-name">新窗口铺满并置顶</div>
          <div class="setting-desc">启动后让程序铺满屏幕并保持最上层（个别程序可能不响应）</div>
        </div>
        <div class="switch ${s.boostLaunch !== false ? 'on' : ''}"></div>
      </div>` : `<div class="setting" data-focusable style="opacity:.55">
        <div class="setting-text">
          <div class="setting-name">新窗口铺满并置顶</div>
          <div class="setting-desc">仅 Windows 支持：需要把别的程序的窗口改成全屏，macOS / Linux 没有对应接口</div>
        </div>
        <div class="badge">Windows</div>
      </div>`}
      <div class="setting" data-focusable data-toggle="sound">
        <div class="setting-text">
          <div class="setting-name">操作音效</div>
          <div class="setting-desc">移动焦点与确认时的轻微提示音</div>
        </div>
        <div class="switch ${s.sound ? 'on' : ''}"></div>
      </div>
      <div class="setting" data-focusable data-toggle="hideHints">
        <div class="setting-text">
          <div class="setting-name">隐藏底部快捷键提示</div>
          <div class="setting-desc">让界面更简洁，适合长期作为电视桌面</div>
        </div>
        <div class="switch ${s.hideHints ? 'on' : ''}"></div>
      </div>
      <div class="section-label" style="margin-top:14px;padding-left:14px">外观</div>
      <div class="setting" data-focusable data-cycle="tileSize">
        <div class="setting-text">
          <div class="setting-name">图标尺寸</div>
          <div class="setting-desc">按屏幕大小选择更合适的磁贴密度</div>
        </div>
        <div class="badge" id="tileSizeBadge">${{ compact: '紧凑', normal: '标准', large: '大' }[s.tileSize] || '标准'}</div>
      </div>
      <div class="setting" data-focusable data-action="pickBg">
        <div class="setting-text">
          <div class="setting-name">背景图片</div>
          <div class="setting-desc">用一张自己的图片当客厅墙纸，自动铺满整个屏幕</div>
        </div>
        <div class="badge" id="bgPicBadge">${bg.file && bg.file !== DEFAULT_BG_FILE ? '更换' : '选择'}</div>
      </div>
      <div class="setting" data-focusable data-cycle="bgDim">
        <div class="setting-text">
          <div class="setting-name">背景暗度</div>
          <div class="setting-desc">压暗背景，让磁贴和文字更清楚（0% 为原图）</div>
        </div>
        <div class="badge" id="bgDimBadge">${Math.round(bg.dim * 100)}%</div>
      </div>
      <div class="setting" data-focusable data-toggle="bgBlur">
        <div class="setting-text">
          <div class="setting-name">背景虚化</div>
          <div class="setting-desc">轻微模糊背景，磁贴轮廓更突出</div>
        </div>
        <div class="switch ${bg.blur ? 'on' : ''}" id="bgBlurSwitch"></div>
      </div>
      <div class="setting" data-focusable data-action="clearBg" id="bgRemoveRow" style="display:${bg.file && bg.file !== DEFAULT_BG_FILE ? '' : 'none'}">
        <div class="setting-text">
          <div class="setting-name" style="color:#ffb4b6">恢复默认壁纸</div>
          <div class="setting-desc">丢掉自定义图片，回到自带的那张电视背景</div>
        </div>
        <div class="badge">恢复</div>
      </div>

      <div class="section-label" style="margin-top:14px;padding-left:14px">手机遥控</div>
      <div class="setting" data-focusable data-action="phoneRemote" data-autofocus>
        <div class="setting-text">
          <div class="setting-name">扫码用手机遥控</div>
          <div class="setting-desc">手机与电脑连同一 WiFi，扫码后即可用手机控制大屏</div>
        </div>
        <div class="badge">开启</div>
      </div>

      <div class="section-label" style="margin-top:14px;padding-left:14px">其它</div>
      <div class="setting" data-focusable data-action="dataDir">
        <div class="setting-text">
          <div class="setting-name">数据目录</div>
          <div class="setting-desc">${esc(state.dataDir)}</div>
        </div>
        <div class="badge">打开</div>
      </div>
      <div class="setting" data-focusable data-action="help">
        <div class="setting-text">
          <div class="setting-name">快捷键与遥控器说明</div>
          <div class="setting-desc">查看全部操作方式</div>
        </div>
        <div class="badge">查看</div>
      </div>
      <div class="setting" data-focusable data-action="quit">
        <div class="setting-text">
          <div class="setting-name" style="color:#ffb4b6">退出启动器</div>
          <div class="setting-desc">${esc(PLAT.text.quitHint)}</div>
        </div>
        <div class="badge">退出</div>
      </div>
    </div>
    <div class="m-foot">
      <div class="foot-hint"><span>版本 ${esc(state.version || '1.0.0')}</span></div>
      <button class="btn" data-close data-focusable>完成</button>
    </div>
  `, { narrow: true, autofocus: '[data-toggle="autostart"]' });

  bindClose();
  bindSettingsRows();
}

function bindSettingsRows() {
  const root = $('#modal');

  // 点哪一行, 高亮就落在哪一行(与磁贴保持一致)
  $$('.setting[data-toggle], .setting[data-cycle], .setting[data-action]', root).forEach((row) => {
    row.addEventListener('pointerdown', () => Focus.set(row, { noScroll: true }));
  });

  $$('.setting[data-toggle]', root).forEach((row) => {
    row.addEventListener('click', () => toggleSetting(row.dataset.toggle, row));
    row.addEventListener('mouseenter', () => hoverFocus(row));
  });

  $$('.setting[data-cycle]', root).forEach((row) => {
    row.addEventListener('click', () => cycleSetting(row));
    row.addEventListener('mouseenter', () => hoverFocus(row));
  });

  $$('.setting[data-action]', root).forEach((row) => {
    row.addEventListener('click', () => runSettingAction(row.dataset.action));
    row.addEventListener('mouseenter', () => hoverFocus(row));
  });
}

async function toggleSetting(key, row) {
  const sw = row.querySelector('.switch');

  // 背景虚化存在 settings.background 里, 单独处理
  if (key === 'bgBlur') {
    const bg = bgSettings();
    const nextBlur = !bg.blur;
    state.settings.background = { ...bg, blur: nextBlur };
    applyBackground();
    sw.classList.toggle('on', nextBlur);
    confirmSound();
    await persist();
    return;
  }

  const next = key === 'autostart'
    ? !state.settings.autostart
    : key === 'fullscreen' ? !(state.settings.fullscreen !== false)
      : !state.settings[key];

  if (key === 'autostart') {
    const r = await api.setAutostart(next);
    if (!r || !r.ok) { toast('设置开机自启失败，请检查系统权限', 'err', 3200); return; }
    state.settings.autostart = !!(r.state && r.state.enabled);
    if (state.settings.autostart !== next) toast('开机自启状态未生效', 'err');
    confirmSound();
  } else if (key === 'fullscreen') {
    state.settings.fullscreen = next;
    await api.setFullscreen(next);
    state.isFullscreen = next;
    confirmSound();
  } else {
    state.settings[key] = next;
    confirmSound();
  }

  sw.classList.toggle('on', key === 'autostart'
    ? state.settings.autostart
    : key === 'fullscreen' ? state.settings.fullscreen !== false : !!state.settings[key]);

  applySettings();
  await persist();
}

/** 循环切换类设置: 图标尺寸 / 背景暗度 */
function cycleSetting(row) {
  const key = row.dataset.cycle;

  if (key === 'bgDim') {
    const bg = bgSettings();
    const i = BG_DIM_STEPS.findIndex((v) => Math.abs(v - bg.dim) < 0.001);
    const nextDim = BG_DIM_STEPS[(i + 1) % BG_DIM_STEPS.length];
    state.settings.background = { ...bg, dim: nextDim };
    applyBackground();
    const badge = $('#bgDimBadge');
    if (badge) badge.textContent = Math.round(nextDim * 100) + '%';
    persist();
    confirmSound();
    return;
  }

  const order = ['compact', 'normal', 'large'];
  const cur = order.indexOf(state.settings.tileSize || 'normal');
  const next = order[(cur + 1) % order.length];
  state.settings.tileSize = next;
  const badge = $('#tileSizeBadge');
  if (badge) badge.textContent = { compact: '紧凑', normal: '标准', large: '大' }[next];
  applySettings();
  persist();
  confirmSound();
  renderGrid();
}

/** 设置面板里的背景相关显示同步(选/移除图片后不重建面板, 避免丢失滚动位置) */
function syncBgRows() {
  const bg = bgSettings();
  const custom = !!bg.file && bg.file !== DEFAULT_BG_FILE;
  const pic = $('#bgPicBadge');
  if (pic) pic.textContent = custom ? '更换' : '选择';
  const dim = $('#bgDimBadge');
  if (dim) dim.textContent = Math.round(bg.dim * 100) + '%';
  const sw = $('#bgBlurSwitch');
  if (sw) sw.classList.toggle('on', bg.blur);
  const rm = $('#bgRemoveRow');
  if (rm) rm.style.display = custom ? '' : 'none';
}

async function pickBackground() {
  let r = null;
  try {
    r = await api.pickBackground();
  } catch (e) {
    toast('打开选择窗口失败: ' + (e && e.message || e), 'err', 3000);
    return;
  }
  if (!r) return; // 用户取消
  if (!r.ok) { toast(r.error || '这张图片不能用作背景', 'err', 3400); return; }
  state.settings.background = { ...bgSettings(), file: r.file };
  applyBackground();
  syncBgRows();
  await persist();
  confirmSound();
  toast('背景已更新', 'ok', 1500);
}

async function clearBackground() {
  state.settings.background = { ...bgSettings(), file: DEFAULT_BG_FILE };
  applyBackground();
  syncBgRows();
  await persist();
  try { await api.clearBackground(); } catch { /* 删不掉也只是留个文件 */ }
  toast('已恢复默认壁纸', 'ok', 1500);
}

async function runSettingAction(action) {
  if (action === 'pickBg') { await pickBackground(); return; }
  if (action === 'clearBg') { await clearBackground(); return; }
  if (action === 'dataDir') { api.openPath(state.dataDir); return; }
  if (action === 'help') { openHelp(); return; }
  if (action === 'phoneRemote') { await openPhoneRemote(); return; }
  if (action === 'quit') { await persist(); api.quit(); }
}

/* =========================================================
   手机遥控
   ========================================================= */
/** 把二维码 SVG 变成可放进 <img> 的 data URI */
function qrDataUri(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/**
 * 打开/刷新"手机遥控"面板：开启服务、显示二维码与配对码。
 * 服务开启后会一直运行直到主动停止或关闭程序；关掉这个弹窗不影响连接。
 */
async function openPhoneRemote(rotate) {
  toast(rotate ? '正在更换配对码…' : '正在开启遥控服务…', 'ok', 1200);
  let info;
  if (rotate) {
    info = await api.remoteRotate();
  } else {
    const status = await api.remoteStatus();
    info = (status && status.running) ? status : await api.remoteStart();
  }
  if (!info || info.ok === false || !info.running) {
    toast('遥控服务开启失败：' + ((info && info.error) || '未知错误'), 'err', 4000);
    return;
  }

  openModal(`
    <div class="m-head">
      <div>
        <div class="m-title">手机遥控</div>
        <div class="m-sub">手机扫码即可把大屏"握在手里"</div>
      </div>
      <button class="btn btn-icon-only" data-close data-focusable title="关闭">✕</button>
    </div>
    <div class="m-body" style="text-align:center">
      <div style="display:inline-block;background:#fff;padding:12px;border-radius:14px;line-height:0">
        <img src="${qrDataUri(info.qrSvg)}" alt="扫码遥控二维码" style="width:216px;height:216px" />
      </div>
      <div style="font-size:15px;font-weight:600;margin-top:14px">用手机相机扫码打开遥控页</div>
      <div style="font-size:13px;color:var(--muted,#93a0c4);margin-top:8px;line-height:1.7">
        若扫不出来，可在手机浏览器手动输入：<br/>
        <span style="font-family:monospace;word-break:break-all;user-select:text">${esc(info.url)}</span>
      </div>
      <div style="display:inline-flex;align-items:center;gap:10px;margin-top:14px;padding:8px 16px;border:1px solid var(--line,#2a3452);border-radius:10px">
        <span style="font-size:12px;opacity:.7">本机地址</span>
        <span style="font-family:monospace">${esc(info.address)}:${esc(info.port)}</span>
      </div>
      <div style="font-size:12px;color:var(--muted,#93a0c4);margin-top:14px;line-height:1.8;text-align:left">
        · 手机必须与电脑连接<strong>同一个 WiFi</strong><br/>
        · 首次开启时 Windows 可能弹出防火墙提示，请勾选"专用网络"并允许<br/>
        · 配对码每次开启随机生成，别人扫到也无法控制<br/>
        · 地址随网络变化；换网络后请重新打开此页获取新二维码
      </div>
    </div>
    <div class="m-foot" style="justify-content:center;gap:10px;flex-wrap:wrap">
      <button class="btn" data-r-action="rotate" data-focusable>换一个配对码</button>
      <button class="btn" data-r-action="stop" data-focusable>停止遥控</button>
      <button class="btn btn-primary" data-close data-focusable>完成</button>
    </div>
  `, { narrow: true, autofocus: '[data-r-action="stop"]' });

  bindClose();
  $('#modal').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r-action]');
    if (!b) return;
    if (b.dataset.rAction === 'rotate') { await openPhoneRemote(true); return; }
    if (b.dataset.rAction === 'stop') {
      await api.remoteStop();
      closeModal();
      toast('手机遥控已停止', 'ok', 1800);
    }
  });
}

/* =========================================================
   帮助
   ========================================================= */
function openHelp() {
  openModal(`
    <div class="m-head">
      <div>
        <div class="m-title">操作说明</div>
        <div class="m-sub">键盘、遥控器与手柄均可操作</div>
      </div>
      <button class="btn btn-icon-only" data-close data-focusable title="关闭">✕</button>
    </div>
    <div class="m-body">
      <div class="section-label" style="padding-left:0">移动与启动</div>
      <div class="setting"><div class="setting-text"><div class="setting-name">方向键 / 遥控器方向键</div><div class="setting-desc">在磁贴之间移动焦点，自动滚动到可见区域</div></div><div class="badge">↑ ↓ ← →</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">确认 / 启动</div><div class="setting-desc">启动当前选中的应用；在弹窗中执行当前按钮</div></div><div class="badge">Enter / OK</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">返回</div><div class="setting-desc">关闭弹窗；在主界面连续按两次可退出启动器</div></div><div class="badge">Esc / Back</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">鼠标</div><div class="setting-desc">单击启动，右键编辑或移除；按住磁贴可拖动排序</div></div><div class="badge">左 / 右键</div></div>
      <div class="section-label" style="margin-top:12px;padding-left:0">启动后的行为</div>
      <div class="setting"><div class="setting-text"><div class="setting-name">收起启动台</div><div class="setting-desc">启动应用后自动隐藏启动台，避免挡住程序</div></div><div class="badge">设置可关</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">新窗口铺满并置顶</div><div class="setting-desc">${PLAT.caps.windowBoost ? '按进程找到新窗口，铺满当前显示器并保持最上层' : '仅 Windows 支持（macOS / Linux 无对应系统接口）'}</div></div><div class="badge">设置可关</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">唤回启动台</div><div class="setting-desc">全局热键；启动台在应用下层时按一下拉到前台，已在前台时按一下收起</div></div><div class="badge">Ctrl+Alt+L</div></div>
      <div class="section-label" style="margin-top:12px;padding-left:0">管理</div>
      <div class="setting"><div class="setting-text"><div class="setting-name">添加 / 编辑 / 移除</div><div class="setting-desc">选择程序文件即可加入，支持一次多选；右键磁贴可直接编辑</div></div><div class="badge">C · E · Del</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">设置</div><div class="setting-desc">开机自启、全屏、音效、图标尺寸</div></div><div class="badge">S</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">背景图片</div><div class="setting-desc">默认自带一张渐变壁纸；也可换自己的图，调暗度、开关虚化、随时恢复默认</div></div><div class="badge">S</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">关机 / 重启</div><div class="setting-desc">右上角图标按钮，需二次确认</div></div><div class="badge">Ctrl+Alt+P / R</div></div>
      <div class="setting"><div class="setting-text"><div class="setting-name">全屏切换</div><div class="setting-desc">在沉浸全屏与窗口模式之间切换</div></div><div class="badge">F11</div></div>
    </div>
    <div class="m-foot">
      <div class="foot-hint"><span>数据目录：${esc(state.dataDir)}</span></div>
      <button class="btn btn-primary" data-close data-focusable>知道了</button>
    </div>
  `, { narrow: true, autofocus: '.m-foot .btn-primary' });
  bindClose();
}

/* =========================================================
   数据
   ========================================================= */
async function persist() {
  try {
    const r = await api.saveState({ items: state.items, settings: state.settings, firstRun: false });
    if (r && r.items) state.items = r.items;
    if (r && r.settings) state.settings = { ...state.settings, ...r.settings };
  } catch (e) {
    toast('保存失败: ' + e.message, 'err', 3000);
  }
}

/**
 * 新建条目
 * @param {{name,target,args,kind,appId,iconFile,iconPath}} app
 * @param {{render?:boolean}} opts render=false 用于批量添加, 由调用方统一刷新一次
 */
async function addApp(app, opts = {}) {
  if (!app || !app.name) return null;
  const render = opts.render !== false;
  const item = {
    id: uid(),
    name: String(app.name).trim().slice(0, 60),
    target: (app.target || '').trim(),
    args: (app.args || '').trim(),
    kind: app.kind === 'uwp' ? 'uwp' : 'exe',
    appId: app.appId || '',
    iconFile: app.iconFile || '',
    iconCustom: !!app.iconCustom,
    iconPath: app.iconPath || '',
    addedAt: Date.now(),
  };
  if (item.kind === 'uwp' && !item.appId) { toast('应用标识缺失，无法添加', 'err'); return null; }
  if (item.kind === 'exe' && !item.target) { toast('程序路径为空，无法添加', 'err'); return null; }
  if (state.items.some((i) => (i.target || '').toLowerCase() === item.target.toLowerCase())) return null;

  // 没有图标时补一次提取
  if (!item.iconFile) {
    try {
      const map = await api.ensureIcons([{
        id: item.id, kind: item.kind, target: item.target,
        appId: item.appId, iconPath: app.iconPath || item.target, name: item.name,
      }]);
      if (map && map[item.id]) item.iconFile = fileFromUrl(map[item.id]);
    } catch { /* 无图标也能用首字母占位 */ }
  }

  state.items.push(item);
  if (render) {
    await persist();
    renderGrid();
    const el = $(`#grid [data-id="${item.id}"]`);
    if (el) Focus.set(el);
  }
  return item;
}

/** 批量添加(多选文件时), 返回实际新增数量 */
async function addMany(files) {
  let n = 0;
  for (const f of files) {
    if (!f || !f.path) continue;
    const item = await addApp({
      name: f.name, target: f.path, args: f.args,
      kind: 'exe', iconPath: f.iconPath || f.path, iconFile: '',
    }, { render: false });
    if (item) n++;
  }
  if (n > 0) {
    await persist();
    renderGrid();
    const last = state.items[state.items.length - 1];
    const el = last && $(`#grid [data-id="${last.id}"]`);
    if (el) Focus.set(el);
  }
  return n;
}

/* =========================================================
   键盘 / 遥控器 / 手柄 / 手机
   ========================================================= */
let lastEscAt = 0;

/* ---- 手机遥控：主进程把指令转到这里，复用同一套焦点系统 ---- */
if (api && api.onRemoteNav) {
  api.onRemoteNav((action) => {
    // 输入框里只认上下, 与键盘行为保持一致
    if (isField(document.activeElement) && action !== 'back' && action !== 'ok') {
      if (action === 'up' || action === 'down') {
        Focus.move(action);
        const el = Focus.el;
        if (el && el !== document.activeElement) {
          if (el.tagName === 'INPUT') el.focus({ preventScroll: true });
          else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        }
      }
      return;
    }
    if (['up', 'down', 'left', 'right'].includes(action)) { Focus.move(action); return; }
    if (action === 'ok') { confirmSound(); confirmFocused(); return; }
    if (action === 'back') { handleBack(); return; }
  });

  api.onRemotePower((kind) => {
    // 大屏上再确认一次, 避免手机误触直接关机
    if (kind === 'shutdown' || kind === 'restart') askPower(kind);
  });

  api.onRemoteToast((text) => { if (text) toast(text, 'ok', 2200); });
}

function isField(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// 原生焦点(鼠标点击 / Tab 键)与视觉焦点保持同步
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (el && el.matches && el.matches('[data-focusable]')) Focus.set(el, { noScroll: true });
});

function handleBack() {
  if (isOverlayOpen()) {
    if (modalEscHandler) { modalEscHandler(); return; }
    closeModal();
    return;
  }
  const now = Date.now();
  if (now - lastEscAt < 1800) { api.quit(); return; }
  lastEscAt = now;
  toast('再按一次 Esc 退出启动器', 'ok', 1800);
}

document.addEventListener('keydown', (e) => {
  const k = e.key;

  // 电源组合键优先
  if (e.ctrlKey && e.altKey) {
    const low = k.toLowerCase();
    if (low === 'p') { e.preventDefault(); askPower('shutdown'); return; }
    if (low === 'r') { e.preventDefault(); askPower('restart'); return; }
  }

  if (k === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
  if (k === 'Escape' || k === 'BrowserBack') { e.preventDefault(); handleBack(); return; }

  if (isField(document.activeElement)) {
    // 输入框内: 上下键用于离开输入框(其余按键交给输入法/原生行为)
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const before = Focus.el;
      Focus.move(k === 'ArrowDown' ? 'down' : 'up');
      if (Focus.el && Focus.el !== before) {
        if (Focus.el.tagName === 'INPUT') Focus.el.focus();
        else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      }
    }
    return;
  }

  const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (dirs[k]) {
    e.preventDefault();
    Focus.move(dirs[k]);
    return;
  }

  // Tab: 弹层内交给浏览器做原生焦点遍历(输入框之间切换更符合直觉)
  if (k === 'Tab') return;

  if (isOverlayOpen()) {
    if (k === 'Enter' || k === 'NumpadEnter' || k === ' ') {
      e.preventDefault();
      confirmFocused();
    }
    return;
  }

  const low = k.toLowerCase();
  if (k === 'Enter' || k === 'NumpadEnter' || k === ' ') {
    e.preventDefault();
    confirmFocused();
    return;
  }
  if (low === 'c' || k === 'Insert') { e.preventDefault(); openAdd(); return; }
  if (low === 's') { e.preventDefault(); openSettings(); return; }
  if (low === 'e' || k === 'F2') { e.preventDefault(); editFocused(); return; }
  if (k === 'Delete') { e.preventDefault(); removeFocused(); return; }
  if (k === 'Home') { e.preventDefault(); const t = Focus.gridTiles()[0]; if (t) Focus.set(t); return; }
  if (k === 'End') { e.preventDefault(); const t = Focus.gridTiles().slice(-1)[0]; if (t) Focus.set(t); return; }
  if (k === 'F1') { e.preventDefault(); openHelp(); return; }
});

/** 确认当前焦点：弹窗里点按钮，主界面里启动磁贴。键盘 Enter 与手机"确定"共用 */
function confirmFocused() {
  if (isOverlayOpen()) {
    const el = Focus.el;
    if (el) { el.click(); confirmSound(); }
    return;
  }
  activateFocused();
}

function activateFocused() {
  const el = Focus.el;
  if (!el) return;
  const id = el.dataset.id;
  if (id) {
    const item = state.items.find((i) => i.id === id);
    if (item) { launchItem(item); return; }
  }
  if (Focus.zoneOf(el) === 'header') { el.click(); return; }
  el.click();
}

function editFocused() {
  const id = Focus.el && Focus.el.dataset.id;
  const item = state.items.find((i) => i.id === id);
  if (item) openEdit(item);
  else toast('请先选中一个应用', 'ok', 1400);
}

function removeFocused() {
  const id = Focus.el && Focus.el.dataset.id;
  const item = state.items.find((i) => i.id === id);
  if (!item) { toast('请先选中一个应用', 'ok', 1400); return; }
  askRemove(item);
}

function askRemove(item) {
  openModal(`
    <div class="m-body" style="padding-top:26px">
      <div class="confirm-title">移除「${esc(clampText(item.name, 24))}」？</div>
      <div class="confirm-sub">只会从启动台移除，不会卸载程序。</div>
    </div>
    <div class="m-foot" style="justify-content:center">
      <button class="btn" data-action="cancel" data-focusable>取消</button>
      <button class="btn btn-danger" data-action="del" data-focusable>移除</button>
    </div>
  `, { tiny: true, autofocus: '[data-action="del"]' });

  $('#modal').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'cancel') { closeModal(); return; }
    state.items = state.items.filter((i) => i.id !== item.id);
    await persist();
    closeModal();
    renderGrid();
    toast(`已移除 · ${item.name}`, 'ok', 1600);
  });
}

async function toggleFullscreen() {
  state.isFullscreen = !state.isFullscreen;
  await api.setFullscreen(state.isFullscreen);
  state.settings.fullscreen = state.isFullscreen;
  persist();
  toast(state.isFullscreen ? '已进入全屏' : '已退出全屏（F11 恢复）', 'ok', 1600);
}

/* ------------------------- 手柄 / 遥控器轮询 ------------------------- */
const padPrev = new Map();
let padRepeatAt = 0;

function pollGamepads() {
  if (!navigator.getGamepads) return;
  const pads = navigator.getGamepads();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p) continue;
    const b = (n) => !!(p.buttons[n] && p.buttons[n].pressed);
    const ax = p.axes[0] || 0;
    const ay = p.axes[1] || 0;
    const st = {
      up: b(12) || ay < -0.65,
      down: b(13) || ay > 0.65,
      left: b(14) || ax < -0.65,
      right: b(15) || ax > 0.65,
      ok: b(0) || b(9),
      back: b(1) || b(8),
    };
    const prev = padPrev.get(i) || {};
    const now = Date.now();

    const dirs = ['up', 'down', 'left', 'right'];
    let handled = false;
    for (const d of dirs) {
      if (st[d] && !prev[d]) {
        if (isField(document.activeElement)) {
          if (d === 'down') Focus.move('down');
        } else {
          Focus.move(d);
        }
        padRepeatAt = now + 340;
        handled = true;
        break;
      }
    }
    if (!handled && now > padRepeatAt) {
      for (const d of dirs) {
        if (st[d]) {
          Focus.move(d);
          padRepeatAt = now + 120;
          break;
        }
      }
    }
    if (st.ok && !prev.ok) {
      if (isField(document.activeElement)) document.activeElement.blur();
      else if (isOverlayOpen()) { if (Focus.el) { Focus.el.click(); confirmSound(); } }
      else activateFocused();
    }
    if (st.back && !prev.back) handleBack();

    padPrev.set(i, st);
  }
  requestAnimationFrame(pollGamepads);
}

/* =========================================================
   启动
   ========================================================= */
/**
 * 启动时把图标补一遍。
 * 一是补齐没有图标的条目; 二是修正老版本留下的错误图标 ——
 * 2.1 及以前对 .lnk 直接向 Shell 要图标, 拿到的是"空白页 + 快捷方式箭头"的通用图标。
 */
async function repairIcons() {
  const need = state.items.filter((it) => !it.iconCustom && it.kind !== 'uwp');
  if (!need.length) return false;
  let map = null;
  try {
    map = await api.ensureIcons(need.map((it) => ({
      id: it.id, kind: it.kind, target: it.target, appId: it.appId, name: it.name,
      iconPath: it.iconPath || it.target,
    })));
  } catch { return false; }
  if (!map) return false;

  let changed = false;
  for (const it of need) {
    const file = map[it.id] ? fileFromUrl(map[it.id]) : '';
    if (file && file !== it.iconFile) { it.iconFile = file; changed = true; }
  }
  if (changed) await persist();
  return changed;
}

(async function init() {
  try {
    const s = await api.getState();
    if (s) {
      state.items = Array.isArray(s.items) ? s.items : [];
      state.settings = { ...state.settings, ...(s.settings || {}) };
      state.firstRun = s.firstRun !== false;
      state.dataDir = s.dataDir || '';
      state.version = s.version || '';
      // 平台信息: 文案与可选项据此调整
      if (s.platform) {
        PLAT = {
          win: s.platform === 'win32',
          mac: s.platform === 'darwin',
          linux: s.platform === 'linux',
          caps: s.caps || PLAT.caps,
          text: { ...PLAT.text, ...(s.text || {}) },
        };
        document.body.dataset.platform = s.platform;
      }
    }
  } catch (e) {
    toast('初始化失败: ' + e.message, 'err', 4000);
  }

  applySettings();
  updateClock();
  setInterval(updateClock, 1000);
  // 窗口被应用完全遮挡时定时器会被节流, 重新可见时补一次, 免得时钟停在旧时间
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateClock();
  });
  renderGrid();

  // 按钮
  $('#btnAdd').addEventListener('click', () => openAdd());
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnRestart').addEventListener('click', () => askPower('restart'));
  $('#btnShutdown').addEventListener('click', () => askPower('shutdown'));
  $$('.hbtn').forEach((b) => {
    b.addEventListener('mouseenter', () => hoverFocus(b));
    b.addEventListener('pointerdown', () => Focus.set(b, { noScroll: true }));
  });

  // 首屏焦点: 有磁贴就落在磁贴上, 空启动台则落在右上角"添加"按钮
  const first = Focus.firstInGrid();
  if (first) Focus.set(first, { instant: true });
  else { const add = $('#btnAdd'); if (add) Focus.set(add, { instant: true }); }

  requestAnimationFrame(pollGamepads);

  // 图标自愈(异步, 不阻塞首屏)
  repairIcons().then((changed) => { if (changed) renderGrid(); }).catch(() => {});

  // 首次运行: 直接打开添加面板, 引导用户把常用软件放进来(只引导一次)
  if (state.firstRun) {
    state.firstRun = false;
    api.saveState({ firstRun: false }).catch(() => {});
    setTimeout(() => openAdd(), 260);
  }
})();

}());
