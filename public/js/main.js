// main.js —— 入口：界面流程、UI 更新、事件编排、启动引导
import { World } from './world.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { AudioFX } from './audio.js';
import { Effects } from './effects.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);

// ---------------- 实例 ----------------
const canvas = $('game-canvas');
const world = new World(canvas);
const net = new Net();
const input = new Input();
const audio = new AudioFX();
const effects = new Effects(world.scene);

// ---------------- UI 适配层 ----------------
const MAGSIZE = 30;
const ui = {
  setHP(side, hp) {
    const el = side === 'me' ? $('hud-hp-me') : $('hud-hp-op');
    el.style.width = Math.max(0, Math.min(100, hp)) + '%';
  },
  setScore(scores, slot) {
    const me = scores[slot] || 0;
    const op = scores[slot === 0 ? 1 : 0] || 0;
    $('hud-score').textContent = `${me} : ${op}`;
  },
  setTimer(ms, phase) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60), s = total % 60;
    $('hud-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
    const tag = $('hud-phase');
    if (phase === 'countdown') { tag.textContent = '准备 ' + total; $('hud-timer').textContent = '0:00'; }
    else if (phase === 'overtime') tag.textContent = '⚡ 加时赛';
    else tag.textContent = '';
  },
  setAmmo(ammo, mag, reloading) {
    $('ammo-count').textContent = reloading ? '换弹…' : `${ammo}/${mag}`;
    $('btn-reload').classList.toggle('reloading', !!reloading);
  },
  showKill(text, dead) {
    const feed = $('killfeed');
    const el = document.createElement('div');
    el.className = 'kill-pop' + (dead ? ' dead' : '');
    el.textContent = text;
    feed.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  },
  showDeath(sec) {
    $('death-overlay').classList.add('show');
    $('respawn-count').textContent = Math.max(1, sec);
  },
  hideDeath() { $('death-overlay').classList.remove('show'); },
  damageFlash() {
    const v = $('damage-vignette');
    v.classList.add('show');
    clearTimeout(this._dmgT);
    this._dmgT = setTimeout(() => v.classList.remove('show'), 180);
  },
  hitMarker() {
    const c = $('crosshair');
    c.classList.add('hit');
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => c.classList.remove('hit'), 140);
  },
  toast(msg) {
    const t = $('net-toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 2600);
  },
};

const game = new Game({ world, net, input, audio, effects, ui });

// ---------------- 界面切换 ----------------
const screens = ['screen-home', 'screen-lobby', 'screen-hud', 'screen-result'];
function show(id) {
  screens.forEach((s) => $(s).classList.toggle('active', s === id));
  document.body.classList.toggle('in-game', id === 'screen-hud');
}

let matchStarted = false;
let myName = '';

function enterMatch() {
  if (matchStarted) return;
  matchStarted = true;
  audio.unlock();
  requestFullscreen();
  game.enter(net.slot);
  game.start();
  show('screen-hud');
  ui.setAmmo(MAGSIZE, MAGSIZE, false);
}

function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }
}

// ---------------- 首页交互 ----------------
$('btn-create').addEventListener('click', async () => {
  audio.unlock();
  myName = $('name-input').value.trim();
  showLoading(true);
  const res = await net.createRoom(myName);
  showLoading(false);
  if (res && res.ok) {
    $('room-code').textContent = res.roomId;
    $('lobby-status').textContent = '把房间号发给好友，对手加入后自动开始';
    show('screen-lobby');
  } else {
    ui.toast('创建房间失败');
  }
});

$('btn-join').addEventListener('click', async () => {
  audio.unlock();
  const roomId = $('room-input').value.trim();
  if (!/^\d{4}$/.test(roomId)) { ui.toast('请输入 4 位房间号'); return; }
  myName = $('name-input').value.trim();
  showLoading(true);
  const res = await net.joinRoom(roomId, myName);
  showLoading(false);
  if (res && res.ok) {
    $('room-code').textContent = res.roomId;
    $('lobby-status').textContent = '已加入，等待开始…';
    show('screen-lobby');
  } else {
    ui.toast(res && res.error ? res.error : '加入失败');
  }
});

$('btn-help').addEventListener('click', () => $('help-modal').classList.add('show'));
$('btn-help-close').addEventListener('click', () => $('help-modal').classList.remove('show'));

// ---------------- 单人训练 ----------------
let soloDifficulty = 'normal';
document.querySelectorAll('.diff-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    soloDifficulty = b.dataset.diff;
  });
});

$('btn-solo').addEventListener('click', async () => {
  audio.unlock();
  myName = $('name-input').value.trim();
  showLoading(true);
  const res = await net.startSolo(myName, soloDifficulty);
  showLoading(false);
  if (!res || !res.ok) {
    ui.toast('开始失败，请重试');
    return;
  }
  // 服务端会立即推 countdown 的 roomState，enterMatch 由网络事件驱动
});

$('btn-copy').addEventListener('click', async () => {
  const code = $('room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    ui.toast('已复制房间号 ' + code);
  } catch (e) {
    ui.toast('房间号：' + code);
  }
});

$('btn-leave-lobby').addEventListener('click', () => {
  net.leaveRoom();
  resetToHome();
});

$('btn-rematch').addEventListener('click', () => {
  net.rematch();
  if (net.solo) {
    ui.toast('再来一局！');
  } else {
    $('lobby-status').textContent = '等待对手准备…';
    ui.toast('已请求再来一局');
  }
});

$('btn-lobby').addEventListener('click', () => {
  net.leaveRoom();
  resetToHome();
});

function resetToHome() {
  matchStarted = false;
  game.stop();
  if (game.opp) { world.removeRemotePlayer(game.opp.slot); game.opp = null; }
  show('screen-home');
}

function showLoading(on) { $('loading').classList.toggle('show', on); }

// ---------------- 网络事件 ----------------
net.on('roomState', (st) => {
  // 房间阶段驱动界面
  if (st.phase === 'waiting') {
    if (!matchStarted) show('screen-lobby');
  } else if (st.phase === 'countdown' || st.phase === 'playing' || st.phase === 'overtime') {
    enterMatch();
  } else if (st.phase === 'ended') {
    if (st.result) showResult(st.result);
  }
});

net.on('matchStart', () => { ui.toast('对战开始！'); });
net.on('overtime', () => { ui.toast('比分相同，进入加时赛！'); });

net.on('gameOver', (data) => { showResult(data.result); });

net.on('opponentLeft', () => {
  ui.toast('对手已离开房间');
  showResult({ reason: 'opponentLeft' });
});
net.on('opponentDisconnected', () => ui.toast('对手连接中断，等待重连…'));
net.on('opponentReconnected', () => ui.toast('对手已重连'));
net.on('disconnected', () => ui.toast('网络中断，重连中…'));
net.on('connected', () => {});
net.on('rejoined', () => ui.toast('已重新连接'));
net.on('rejoinFailed', () => { ui.toast('无法重连，返回大厅'); resetToHome(); });

function showResult(result) {
  game.stop();
  matchStarted = false;
  const slot = net.slot;
  const title = $('result-title');
  const sub = $('result-reason');
  sub.textContent = '';
  title.className = 'result-title';

  if (result.reason === 'opponentLeft') {
    title.textContent = '对手已离开';
    title.classList.add('win');
    sub.textContent = '本局结束';
    audio.victory();
  } else if (result.draw) {
    title.textContent = '平局';
    title.classList.add('draw');
    audio.defeat();
  } else if (result.winner === slot) {
    title.textContent = '胜利';
    title.classList.add('win');
    audio.victory();
  } else {
    title.textContent = '失败';
    title.classList.add('lose');
    audio.defeat();
  }

  if (result.scores) {
    const me = result.scores[slot] || 0;
    const op = result.scores[slot === 0 ? 1 : 0] || 0;
    $('result-score').textContent = `${me} : ${op}`;
  } else {
    $('result-score').textContent = $('hud-score').textContent;
  }
  show('screen-result');
}

// ---------------- 系统 ----------------
window.addEventListener('resize', () => world.resize());
window.addEventListener('orientationchange', () => setTimeout(() => world.resize(), 200));

// 阻止移动端默认手势/缩放
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// 首次进入预渲染一帧（避免黑屏）
world.render();
show('screen-home');
