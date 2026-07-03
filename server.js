/*
 * 极速枪战 Arena —— 服务端
 * 职责：大厅 / 房间管理、实时同步、服务端权威战斗校验（血量、命中、击杀、比分、复活）、
 *       计时与加时、断线/重连/房间销毁等异常处理。
 *
 * 设计：移动与朝向由客户端预测并上报，服务端转发以保证低延迟；
 *       但「关键战斗数据」（命中判定、扣血、击杀、比分、弹药、复活）完全由服务端裁决，
 *       防止前端篡改作弊。
 */
'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const MAP = require('./public/shared/map.js');
const WEAPONS = require('./public/shared/weapons.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 8000,
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
// 3D 素材（GLB 模型）
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---------------------------------------------------------------------------
// 游戏常量
// ---------------------------------------------------------------------------
const MAX_HP = 100;
const RESPAWN_MS = 3000;
const INVULN_MS = 1000;
const COUNTDOWN_MS = 3000;
const MATCH_MS = 180000;   // 3 分钟
const OVERTIME_MS = 30000; // 加时 30 秒
const TICK_HZ = 30;
const SNAPSHOT_EVERY = 2;  // 每 2 个 tick 广播一次权威快照（≈15Hz）
const DROP_GRACE_MS = 10000; // 断线宽限，期间可重连

const COLORS = [0x3b82f6, 0xef4444]; // 蓝 / 红

// ---------------------------------------------------------------------------
// 房间存储
// ---------------------------------------------------------------------------
const rooms = new Map();      // roomId -> room
const socketIndex = new Map(); // socket.id -> { roomId, token }

function genRoomId() {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(id));
  return id;
}

function weaponConfig(id) {
  return WEAPONS.byId[id] || WEAPONS.byId[WEAPONS.defaultId];
}

function freshAmmo() {
  return Object.fromEntries(WEAPONS.list.map((w) => [w.id, w.mag]));
}

function freshStats() {
  return {
    shots: 0,
    hits: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    reloads: 0,
  };
}

function currentAmmo(p) {
  if (!p.ammoByWeapon) p.ammoByWeapon = freshAmmo();
  const cfg = weaponConfig(p.weapon);
  if (typeof p.ammoByWeapon[cfg.id] !== 'number') p.ammoByWeapon[cfg.id] = cfg.mag;
  return p.ammoByWeapon[cfg.id];
}

function setCurrentAmmo(p, ammo) {
  const cfg = weaponConfig(p.weapon);
  if (!p.ammoByWeapon) p.ammoByWeapon = freshAmmo();
  p.ammoByWeapon[cfg.id] = Math.max(0, Math.min(cfg.mag, ammo));
  p.ammo = p.ammoByWeapon[cfg.id];
  return p.ammo;
}

function syncCurrentAmmo(p) {
  p.ammo = currentAmmo(p);
  return p.ammo;
}

function makePlayer(slot) {
  const sp = MAP.spawns[slot];
  const weapon = WEAPONS.defaultId;
  const ammoByWeapon = freshAmmo();
  return {
    token: crypto.randomBytes(8).toString('hex'),
    socketId: null,
    slot,
    color: COLORS[slot],
    name: '玩家' + (slot + 1),
    pos: { x: sp.x, y: MAP.EYE_HEIGHT, z: sp.z },
    yaw: sp.yaw,
    pitch: 0,
    moving: false,
    hp: MAX_HP,
    weapon,
    ammoByWeapon,
    ammo: ammoByWeapon[weapon],
    reloading: false,
    reloadEnd: 0,
    alive: true,
    score: 0,
    stats: freshStats(),
    respawnAt: 0,
    invulnUntil: 0,
    lastShot: 0,
    connected: false,
    dropAt: 0,
  };
}

// 三档 AI 难度参数
// reactMs: 发现目标后开火前的反应延迟；aimErr: 瞄准角度误差(弧度)；
// fireGap: 连续开火最小间隔(ms)；engage: 期望交战距离；aggro: 移动积极性(0~1)
const BOT_DIFFICULTY = {
  easy:   { reactMs: 520, aimErr: 0.11,  fireGap: 620, engage: 12, aggro: 0.45, loseSightMs: 900 },
  normal: { reactMs: 300, aimErr: 0.055, fireGap: 380, engage: 10, aggro: 0.7,  loseSightMs: 1200 },
  hard:   { reactMs: 140, aimErr: 0.022, fireGap: 240, engage: 8,  aggro: 0.92, loseSightMs: 1800 },
};

function makeBot(slot, difficulty) {
  const p = makePlayer(slot);
  p.name = ['菜鸟机器人', '标准机器人', '精英机器人'][['easy', 'normal', 'hard'].indexOf(difficulty)] || '机器人';
  p.isBot = true;
  p.connected = true; // 让房间视其为在场玩家，参与开赛/计分
  p.socketId = null;
  // AI 运行时状态
  p.ai = {
    cfg: BOT_DIFFICULTY[difficulty] || BOT_DIFFICULTY.normal,
    difficulty: difficulty || 'normal',
    seenAt: 0,        // 最近一次看见目标的时间
    lastSeenPos: null, // 最近看见目标的位置（丢失视野后前往）
    nextFireAt: 0,     // 下次可开火时间
    strafeDir: 1,      // 侧移方向
    strafeUntil: 0,    // 侧移切换时间
    wanderTarget: null, // 无目标时的游走点
  };
  return p;
}

function createRoom(opts) {
  const id = genRoomId();
  const room = {
    id,
    players: [], // index by slot
    phase: 'waiting', // waiting | countdown | playing | overtime | ended
    phaseEnd: 0,      // 当前阶段结束的时间戳（countdown/playing/overtime）
    matchEnd: 0,
    tick: 0,
    loop: null,
    createdAt: Date.now(),
    result: null,
    solo: !!(opts && opts.solo), // 单人模式（含 bot），对手离开即销毁
  };
  rooms.set(id, room);
  return room;
}

function roomActivePlayers(room) {
  return room.players.filter((p) => p && p.connected);
}

function publicPlayer(p) {
  const cfg = weaponConfig(p.weapon);
  syncCurrentAmmo(p);
  return {
    slot: p.slot,
    color: p.color,
    name: p.name,
    hp: p.hp,
    ammo: p.ammo,
    ammoByWeapon: { ...p.ammoByWeapon },
    weapon: cfg.id,
    mag: cfg.mag,
    reloading: p.reloading,
    alive: p.alive,
    score: p.score,
    connected: p.connected,
    stats: { ...p.stats },
  };
}

function roomState(room) {
  const now = Date.now();
  let timeLeft = 0;
  if (room.phase === 'playing' || room.phase === 'overtime') {
    timeLeft = Math.max(0, room.phaseEnd - now);
  } else if (room.phase === 'countdown') {
    timeLeft = Math.max(0, room.phaseEnd - now);
  }
  return {
    roomId: room.id,
    phase: room.phase,
    timeLeft,
    players: room.players.filter(Boolean).map(publicPlayer),
    result: room.result,
  };
}

function emitRoom(room, event, payload) {
  io.to(room.id).emit(event, payload);
}

function broadcastState(room) {
  emitRoom(room, 'roomState', roomState(room));
}

// ---------------------------------------------------------------------------
// 数学：服务端命中校验
// ---------------------------------------------------------------------------
// 射线与 AABB 求交，返回入射 t（>0），无交返回 Infinity
function rayAABB(o, d, b) {
  const minx = b.cx - b.sx / 2, maxx = b.cx + b.sx / 2;
  const miny = b.cy - b.sy / 2, maxy = b.cy + b.sy / 2;
  const minz = b.cz - b.sz / 2, maxz = b.cz + b.sz / 2;
  let tmin = -Infinity, tmax = Infinity;
  const axes = [
    [o.x, d.x, minx, maxx],
    [o.y, d.y, miny, maxy],
    [o.z, d.z, minz, maxz],
  ];
  for (const [oo, dd, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-8) {
      if (oo < lo || oo > hi) return Infinity;
    } else {
      let t1 = (lo - oo) / dd;
      let t2 = (hi - oo) / dd;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  if (tmax < 0) return Infinity;
  return tmin > 0 ? tmin : 0;
}

// 射线与玩家垂直圆柱求交，返回 t（>0），无交返回 Infinity
function rayPlayer(o, d, target) {
  const r = MAP.PLAYER_RADIUS;
  const feetY = target.pos.y - MAP.EYE_HEIGHT;
  const topY = feetY + MAP.PLAYER_HEIGHT;
  const px = target.pos.x, pz = target.pos.z;
  const ox = o.x - px, oz = o.z - pz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-8) return Infinity; // 近乎垂直射击，忽略
  const b = 2 * (d.x * ox + d.z * oz);
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0) return Infinity;
  const y = o.y + d.y * t;
  if (y < feetY || y > topY) return Infinity;
  return t;
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// ---------------------------------------------------------------------------
// 游戏流程
// ---------------------------------------------------------------------------
function spawnPlayer(p) {
  const sp = MAP.spawns[p.slot];
  p.pos = { x: sp.x, y: MAP.EYE_HEIGHT, z: sp.z };
  p.yaw = sp.yaw;
  p.pitch = 0;
  p.hp = MAX_HP;
  p.weapon = WEAPONS.defaultId;
  p.ammoByWeapon = freshAmmo();
  syncCurrentAmmo(p);
  p.reloading = false;
  p.reloadEnd = 0;
  p.alive = true;
  p.invulnUntil = Date.now() + INVULN_MS;
}

function startMatch(room) {
  room.players.forEach((p) => {
    if (!p) return;
    p.score = 0;
    p.stats = freshStats();
    spawnPlayer(p);
  });
  room.phase = 'countdown';
  room.phaseEnd = Date.now() + COUNTDOWN_MS;
  room.result = null;
  broadcastState(room);
  if (!room.loop) {
    room.loop = setInterval(() => gameTick(room), 1000 / TICK_HZ);
  }
}

function endMatch(room) {
  room.phase = 'ended';
  const [a, b] = room.players;
  let result;
  if (!a || !b) {
    result = { reason: 'opponentLeft' };
  } else if (a.score === b.score) {
    result = { draw: true, scores: [a.score, b.score] };
  } else {
    const winner = a.score > b.score ? a.slot : b.slot;
    result = { winner, scores: [a.score, b.score] };
  }
  result.players = room.players.filter(Boolean).map(publicPlayer);
  room.result = result;
  emitRoom(room, 'gameOver', { result, players: room.players.filter(Boolean).map(publicPlayer) });
  broadcastState(room);
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
}

function gameTick(room) {
  const now = Date.now();
  room.tick++;
  const dt = 1 / TICK_HZ;

  // 复活处理
  room.players.forEach((p) => {
    if (!p) return;
    if (!p.alive && p.respawnAt && now >= p.respawnAt) {
      spawnPlayer(p);
      p.respawnAt = 0;
      if (p.isBot && p.ai) { p.ai.seenAt = 0; p.ai.lastSeenPos = null; p.ai.wanderTarget = null; }
      emitRoom(room, 'respawn', {
        slot: p.slot,
        pos: p.pos,
        yaw: p.yaw,
        invulnUntil: p.invulnUntil,
        weapon: p.weapon,
        ammo: p.ammo,
        ammoByWeapon: { ...p.ammoByWeapon },
        mag: weaponConfig(p.weapon).mag,
      });
    }
    // 换弹完成
    if (p.reloading && now >= p.reloadEnd) {
      const cfg = weaponConfig(p.weapon);
      p.reloading = false;
      setCurrentAmmo(p, cfg.mag);
      if (p.socketId) io.to(p.socketId).emit('reloaded', { weapon: cfg.id, ammo: p.ammo, mag: cfg.mag });
    }
  });

  // 阶段切换
  if (room.phase === 'countdown' && now >= room.phaseEnd) {
    room.phase = 'playing';
    room.phaseEnd = now + MATCH_MS;
    emitRoom(room, 'matchStart', { timeLeft: MATCH_MS });
    broadcastState(room);
  } else if (room.phase === 'playing' && now >= room.phaseEnd) {
    const [a, b] = room.players;
    if (a && b && a.score === b.score) {
      // 平局进入加时（先击败对方者胜）
      room.phase = 'overtime';
      room.phaseEnd = now + OVERTIME_MS;
      room.players.forEach((p) => p && spawnPlayer(p));
      emitRoom(room, 'overtime', { timeLeft: OVERTIME_MS });
      broadcastState(room);
    } else {
      endMatch(room);
      return;
    }
  } else if (room.phase === 'overtime' && now >= room.phaseEnd) {
    // 加时结束仍未分胜负 → 按比分裁决（若仍相同则平局）
    endMatch(room);
    return;
  }

  // 驱动 AI 敌人（在快照前，保证位置/血量最新）
  updateBots(room, dt);

  // 权威快照
  if (room.tick % SNAPSHOT_EVERY === 0) {
    const players = room.players.filter(Boolean).map((p) => ({
      slot: p.slot, hp: p.hp, ammo: syncCurrentAmmo(p), ammoByWeapon: { ...p.ammoByWeapon },
      weapon: weaponConfig(p.weapon).id, mag: weaponConfig(p.weapon).mag, reloading: p.reloading,
      alive: p.alive, score: p.score, connected: p.connected,
      respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - now),
      stats: { ...p.stats },
    }));
    let timeLeft = 0;
    if (room.phase === 'playing' || room.phase === 'overtime' || room.phase === 'countdown') {
      timeLeft = Math.max(0, room.phaseEnd - now);
    }
    emitRoom(room, 'snapshot', { phase: room.phase, timeLeft, players });
  }
}

function applyKill(room, killer, victim) {
  victim.alive = false;
  victim.hp = 0;
  victim.respawnAt = Date.now() + RESPAWN_MS;
  if (killer) {
    killer.score += 1;
    killer.stats.kills += 1;
  }
  victim.stats.deaths += 1;
  emitRoom(room, 'kill', {
    killer: killer ? killer.slot : -1,
    victim: victim.slot,
    scores: room.players.filter(Boolean).map((p) => p.score),
    stats: room.players.filter(Boolean).map((p) => ({ slot: p.slot, stats: { ...p.stats } })),
  });

  // 加时赛：先击杀者直接获胜
  if (room.phase === 'overtime' && killer) {
    endMatch(room);
  }
}

// ---------------------------------------------------------------------------
// AI 敌人（服务端机器人）
// ---------------------------------------------------------------------------
// 从 shooter 视线到 target 是否可见（未被掩体遮挡）。返回命中 t（可见）或 Infinity。
function botLineOfSight(shooter, target) {
  const origin = { x: shooter.pos.x, y: shooter.pos.y, z: shooter.pos.z };
  const dir = normalize({
    x: target.pos.x - origin.x,
    y: target.pos.y - origin.y,
    z: target.pos.z - origin.z,
  });
  const tPlayer = rayPlayer(origin, dir, target);
  if (tPlayer === Infinity) return Infinity;
  for (const b of MAP.colliders) {
    if (b.type === 'ground') continue;
    const tb = rayAABB(origin, dir, b);
    if (tb !== Infinity && tb < tPlayer - 0.05) return Infinity; // 被挡
  }
  return tPlayer;
}

// bot 射击：走与真人相同的权威裁决（命中/扣血/击杀/计分/广播）
function botShoot(room, bot, target) {
  const now = Date.now();
  const cfgWeapon = weaponConfig(bot.weapon);
  if (currentAmmo(bot) <= 0 || bot.reloading) return;
  setCurrentAmmo(bot, currentAmmo(bot) - 1);
  bot.stats.shots += 1;

  const origin = { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z };
  const cfg = bot.ai.cfg;
  // 朝目标 + 难度相关的瞄准误差
  const base = normalize({
    x: target.pos.x - origin.x,
    y: target.pos.y - origin.y,
    z: target.pos.z - origin.z,
  });
  const dir = normalize({
    x: base.x + (Math.random() - 0.5) * cfg.aimErr,
    y: base.y + (Math.random() - 0.5) * cfg.aimErr,
    z: base.z + (Math.random() - 0.5) * cfg.aimErr,
  });

  // 让玩家看到 bot 开火（弹道/枪口火光）
  emitRoom(room, 'oppShot', { slot: bot.slot, origin, dir, weapon: cfgWeapon.id });

  if (target.alive && now > target.invulnUntil) {
    const tPlayer = rayPlayer(origin, dir, target);
    if (tPlayer !== Infinity) {
      let blocked = false;
      for (const b of MAP.colliders) {
        if (b.type === 'ground') continue;
        const tb = rayAABB(origin, dir, b);
        if (tb !== Infinity && tb < tPlayer - 0.05) { blocked = true; break; }
      }
      if (!blocked) {
        const before = target.hp;
        target.hp = Math.max(0, target.hp - cfgWeapon.damage);
        const dealt = before - target.hp;
        bot.stats.hits += 1;
        bot.stats.damageDealt += dealt;
        target.stats.damageTaken += dealt;
        const point = {
          x: origin.x + dir.x * tPlayer,
          y: origin.y + dir.y * tPlayer,
          z: origin.z + dir.z * tPlayer,
        };
        emitRoom(room, 'hit', {
          attacker: bot.slot, victim: target.slot, hp: target.hp, point, dmg: dealt, weapon: cfgWeapon.id,
        });
        if (target.hp <= 0) applyKill(room, bot, target);
      }
    }
  }

  if (currentAmmo(bot) <= 0) {
    bot.reloading = true;
    bot.reloadEnd = now + cfgWeapon.reloadMs;
  }
}

function botAimYaw(from, to) {
  // 朝向约定：forward = (-sin(yaw), 0, -cos(yaw))
  const dx = to.x - from.x, dz = to.z - from.z;
  return Math.atan2(-dx, -dz);
}

// 尝试沿 (dx,dz) 移动 bot，撞掩体则不动（分轴调用实现贴墙滑动）
function botTryMove(bot, dx, dz) {
  const r = MAP.PLAYER_RADIUS;
  const nx = bot.pos.x + dx;
  const nz = bot.pos.z + dz;
  const bodyMin = bot.pos.y - MAP.EYE_HEIGHT;
  const bodyMax = bodyMin + MAP.PLAYER_HEIGHT;
  for (const b of MAP.colliders) {
    if (b.type === 'ground' || b.type === 'ramp') continue;
    const minY = b.cy - b.sy / 2, maxY = b.cy + b.sy / 2;
    if (maxY <= bodyMin + 0.05 || minY >= bodyMax) continue;
    const minX = b.cx - b.sx / 2, maxX = b.cx + b.sx / 2;
    const minZ = b.cz - b.sz / 2, maxZ = b.cz + b.sz / 2;
    if (nx + r > minX && nx - r < maxX && nz + r > minZ && nz - r < maxZ) return;
  }
  bot.pos.x = nx; bot.pos.z = nz;
}

const BOT_SPEED = 5.4; // 略低于真人 6.2，给玩家一点优势

function updateBots(room, dt) {
  if (room.phase !== 'playing' && room.phase !== 'overtime') return;
  const now = Date.now();
  for (const bot of room.players) {
    if (!bot || !bot.isBot || !bot.alive) continue;
    const ai = bot.ai;
    const cfg = ai.cfg;

    // 换弹完成由 gameTick 统一处理；这里只做行为
    const target = room.players.find((p) => p && p.slot !== bot.slot && p.connected && !p.isBot);
    if (!target) continue;

    const los = target.alive ? botLineOfSight(bot, target) : Infinity;
    const canSee = los !== Infinity;
    if (canSee) {
      if (!ai.seenAt) ai.seenAt = now;
      ai.lastSeenPos = { x: target.pos.x, y: target.pos.y, z: target.pos.z };
    } else if (ai.seenAt && now - ai.seenAt > cfg.loseSightMs) {
      ai.seenAt = 0;
    }

    // 朝向：看得见就瞄准目标，否则朝最近记忆点/游走点
    let faceTo = null;
    if (canSee) faceTo = target.pos;
    else if (ai.lastSeenPos) faceTo = ai.lastSeenPos;
    if (faceTo) {
      const desiredYaw = botAimYaw(bot.pos, faceTo);
      let dy = desiredYaw - bot.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      // 困难转向更快
      const turn = Math.min(1, dt * (cfg.aggro * 6 + 4));
      bot.yaw += dy * turn;
    }

    // 移动：看得见目标则维持交战距离 + 侧移；否则前往记忆点
    let moveTarget = canSee ? target.pos : (ai.seenAt ? ai.lastSeenPos : null);
    if (!moveTarget) {
      // 无目标：随机游走
      if (!ai.wanderTarget || now > (ai.wanderUntil || 0) ||
          Math.hypot(bot.pos.x - ai.wanderTarget.x, bot.pos.z - ai.wanderTarget.z) < 2) {
        const lim = MAP.HALF - 4;
        ai.wanderTarget = { x: (Math.random() * 2 - 1) * lim, z: (Math.random() * 2 - 1) * lim };
        ai.wanderUntil = now + 3000 + Math.random() * 2000;
      }
      moveTarget = ai.wanderTarget;
    }

    const dxT = moveTarget.x - bot.pos.x;
    const dzT = moveTarget.z - bot.pos.z;
    const dist = Math.hypot(dxT, dzT) || 1;
    let mvx = 0, mvz = 0;
    if (canSee) {
      // 维持理想交战距离
      const diff = dist - cfg.engage;
      let towards = 0;
      if (diff > 1.5) towards = 1;        // 太远，靠近
      else if (diff < -1.5) towards = -1; // 太近，后撤
      mvx += (dxT / dist) * towards;
      mvz += (dzT / dist) * towards;
      // 侧移（绕圈躲子弹）
      if (now > ai.strafeUntil) { ai.strafeDir = Math.random() < 0.5 ? 1 : -1; ai.strafeUntil = now + 700 + Math.random() * 800; }
      const perpX = -(dzT / dist) * ai.strafeDir;
      const perpZ = (dxT / dist) * ai.strafeDir;
      mvx += perpX * cfg.aggro;
      mvz += perpZ * cfg.aggro;
    } else {
      // 前往目标点
      mvx += dxT / dist;
      mvz += dzT / dist;
    }
    const mlen = Math.hypot(mvx, mvz);
    if (mlen > 0.01) {
      mvx /= mlen; mvz /= mlen;
      const step = BOT_SPEED * dt * (canSee ? 1 : cfg.aggro * 0.6 + 0.4);
      botTryMove(bot, mvx * step, 0);
      botTryMove(bot, 0, mvz * step);
      bot.moving = true;
    } else {
      bot.moving = false;
    }

    // 边界
    const lim = MAP.HALF - 1 - MAP.PLAYER_RADIUS;
    bot.pos.x = Math.max(-lim, Math.min(lim, bot.pos.x));
    bot.pos.z = Math.max(-lim, Math.min(lim, bot.pos.z));

    // 射击：看得见 + 过了反应延迟 + 过了射击间隔
    if (canSee && !bot.reloading && currentAmmo(bot) > 0 &&
        ai.seenAt && now - ai.seenAt >= cfg.reactMs && now >= ai.nextFireAt) {
      botShoot(room, bot, target);
      ai.nextFireAt = now + cfg.fireGap + Math.random() * cfg.fireGap * 0.4;
    }

    // 广播 bot 状态（复用 oppState，客户端零改动）
    emitRoom(room, 'oppState', {
      slot: bot.slot, pos: { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z },
      yaw: bot.yaw, pitch: 0, moving: bot.moving, weapon: bot.weapon,
    });
  }
}

// ---------------------------------------------------------------------------
// Socket 事件
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {

  function currentRoom() {
    const idx = socketIndex.get(socket.id);
    return idx ? rooms.get(idx.roomId) : null;
  }
  function currentPlayer() {
    const room = currentRoom();
    if (!room) return null;
    const idx = socketIndex.get(socket.id);
    return room.players.find((p) => p && p.token === idx.token) || null;
  }

  // 创建房间
  socket.on('createRoom', (data, cb) => {
    const room = createRoom();
    const player = makePlayer(0);
    player.socketId = socket.id;
    player.connected = true;
    if (data && data.name) player.name = String(data.name).slice(0, 12);
    room.players[0] = player;
    socket.join(room.id);
    socketIndex.set(socket.id, { roomId: room.id, token: player.token });
    cb && cb({ ok: true, roomId: room.id, slot: 0, token: player.token, color: player.color, map: { spawns: MAP.spawns } });
    broadcastState(room);
  });

  // 单人训练：玩家占 slot 0，生成 AI bot 占 slot 1，立即开赛
  socket.on('startSolo', (data, cb) => {
    const difficulty = (data && ['easy', 'normal', 'hard'].includes(data.difficulty)) ? data.difficulty : 'normal';
    const room = createRoom({ solo: true });
    const player = makePlayer(0);
    player.socketId = socket.id;
    player.connected = true;
    if (data && data.name) player.name = String(data.name).slice(0, 12);
    room.players[0] = player;

    const bot = makeBot(1, difficulty);
    room.players[1] = bot;

    socket.join(room.id);
    socketIndex.set(socket.id, { roomId: room.id, token: player.token });
    cb && cb({ ok: true, roomId: room.id, slot: 0, token: player.token, color: player.color, solo: true, difficulty });
    startMatch(room);
  });

  // 加入房间
  socket.on('joinRoom', (data, cb) => {
    const roomId = data && String(data.roomId || '').trim();
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false, error: '房间不存在' });
    const active = roomActivePlayers(room);
    if (active.length >= 2) return cb && cb({ ok: false, error: '房间已满' });
    if (room.phase === 'ended') return cb && cb({ ok: false, error: '该房间对局已结束' });

    // 找一个空位（slot 1 优先，或被断线腾出的位）
    let slot = -1;
    for (let i = 0; i < 2; i++) {
      if (!room.players[i] || !room.players[i].connected) { slot = i; break; }
    }
    if (slot === -1) return cb && cb({ ok: false, error: '房间已满' });

    const player = room.players[slot] && !room.players[slot].connected
      ? room.players[slot] // 复用被腾出的位（极少见）
      : makePlayer(slot);
    player.socketId = socket.id;
    player.connected = true;
    if (data && data.name) player.name = String(data.name).slice(0, 12);
    room.players[slot] = player;
    socket.join(room.id);
    socketIndex.set(socket.id, { roomId: room.id, token: player.token });
    cb && cb({ ok: true, roomId: room.id, slot, token: player.token, color: player.color });

    broadcastState(room);

    // 满 2 人自动开始
    if (roomActivePlayers(room).length === 2 && room.phase === 'waiting') {
      startMatch(room);
    }
  });

  // 断线重连
  socket.on('rejoin', (data, cb) => {
    const room = rooms.get(data && data.roomId);
    if (!room) return cb && cb({ ok: false, error: '房间已不存在' });
    const player = room.players.find((p) => p && p.token === data.token);
    if (!player) return cb && cb({ ok: false, error: '玩家信息失效' });
    player.socketId = socket.id;
    player.connected = true;
    player.dropAt = 0;
    socket.join(room.id);
    socketIndex.set(socket.id, { roomId: room.id, token: player.token });
    cb && cb({ ok: true, roomId: room.id, slot: player.slot, token: player.token, color: player.color, state: roomState(room) });
    emitRoom(room, 'opponentReconnected', { slot: player.slot });
    broadcastState(room);
  });

  // 移动 / 朝向上报（事件驱动转发，低延迟）
  socket.on('move', (m) => {
    const room = currentRoom();
    const p = currentPlayer();
    if (!room || !p || !p.alive) return;
    if (m && m.pos) {
      p.pos.x = m.pos.x; p.pos.y = m.pos.y; p.pos.z = m.pos.z;
    }
    if (typeof m.yaw === 'number') p.yaw = m.yaw;
    if (typeof m.pitch === 'number') p.pitch = m.pitch;
    p.moving = !!m.moving;
    // 转发给对手
    socket.to(room.id).emit('oppState', {
      slot: p.slot, pos: p.pos, yaw: p.yaw, pitch: p.pitch, moving: p.moving, weapon: p.weapon,
    });
  });

  socket.on('switchWeapon', (data) => {
    const room = currentRoom();
    const p = currentPlayer();
    if (!room || !p || !p.alive) return;
    const next = data && typeof data.weapon === 'string' ? data.weapon : '';
    if (!WEAPONS.byId[next] || p.weapon === next) return;
    p.weapon = next;
    p.reloading = false;
    p.reloadEnd = 0;
    syncCurrentAmmo(p);
    const cfg = weaponConfig(p.weapon);
    if (p.socketId) io.to(p.socketId).emit('weaponChanged', {
      weapon: cfg.id,
      ammo: p.ammo,
      ammoByWeapon: { ...p.ammoByWeapon },
      mag: cfg.mag,
      reloading: false,
    });
    socket.to(room.id).emit('oppWeapon', { slot: p.slot, weapon: cfg.id });
  });

  // 射击（服务端裁决命中）
  socket.on('shoot', (data) => {
    const room = currentRoom();
    const shooter = currentPlayer();
    if (!room || !shooter) return;
    if (room.phase !== 'playing' && room.phase !== 'overtime') return;
    const cfg = weaponConfig(shooter.weapon);
    if (!shooter.alive || shooter.reloading || currentAmmo(shooter) <= 0) return;
    const now = Date.now();
    if (now - shooter.lastShot < cfg.cooldownMs) return;
    shooter.lastShot = now;
    setCurrentAmmo(shooter, currentAmmo(shooter) - 1);
    shooter.stats.shots += 1;

    const origin = { x: shooter.pos.x, y: shooter.pos.y, z: shooter.pos.z };
    const dir = normalize(data && data.dir ? data.dir : { x: 0, y: 0, z: -1 });

    // 让对手看到开火（弹道/枪口火光）
    socket.to(room.id).emit('oppShot', { slot: shooter.slot, origin, dir, weapon: cfg.id });

    // 找对手
    const target = room.players.find((p) => p && p.slot !== shooter.slot && p.connected);
    let hitInfo = null;
    if (target && target.alive && now > target.invulnUntil) {
      const tPlayer = rayPlayer(origin, dir, target);
      if (tPlayer !== Infinity) {
        // 遮挡检测：任意掩体比玩家更近则被挡住
        let blocked = false;
        for (const b of MAP.colliders) {
          const tb = rayAABB(origin, dir, b);
          if (tb !== Infinity && tb < tPlayer - 0.05) { blocked = true; break; }
        }
        if (!blocked) {
          const before = target.hp;
          target.hp = Math.max(0, target.hp - cfg.damage);
          const dealt = before - target.hp;
          shooter.stats.hits += 1;
          shooter.stats.damageDealt += dealt;
          target.stats.damageTaken += dealt;
          const point = {
            x: origin.x + dir.x * tPlayer,
            y: origin.y + dir.y * tPlayer,
            z: origin.z + dir.z * tPlayer,
          };
          hitInfo = { tPlayer, point };
          emitRoom(room, 'hit', {
            attacker: shooter.slot, victim: target.slot, hp: target.hp, point, dmg: dealt, weapon: cfg.id,
          });
          if (target.hp <= 0) applyKill(room, shooter, target);
        }
      }
    }

    // 通知射手命中反馈 + 弹药
    if (shooter.socketId) {
      io.to(shooter.socketId).emit('shotResult', {
        weapon: cfg.id,
        ammo: shooter.ammo,
        ammoByWeapon: { ...shooter.ammoByWeapon },
        mag: cfg.mag,
        hit: !!hitInfo,
        kill: hitInfo && target && target.hp <= 0,
        stats: { ...shooter.stats },
      });
    }
    // 弹药打空自动提示
    if (currentAmmo(shooter) <= 0 && shooter.socketId) {
      io.to(shooter.socketId).emit('emptyMag', {});
    }
  });

  // 换弹（服务端计时）
  socket.on('reload', () => {
    const p = currentPlayer();
    if (!p || !p.alive || p.reloading) return;
    const cfg = weaponConfig(p.weapon);
    if (currentAmmo(p) >= cfg.mag) return;
    p.reloading = true;
    p.reloadEnd = Date.now() + cfg.reloadMs;
    p.stats.reloads += 1;
    if (p.socketId) io.to(p.socketId).emit('reloadStart', { weapon: cfg.id, duration: cfg.reloadMs, ammo: p.ammo, mag: cfg.mag });
  });

  // 再来一局
  socket.on('rematch', () => {
    const room = currentRoom();
    if (!room) return;
    if (room.phase !== 'ended') return;
    if (roomActivePlayers(room).length === 2) {
      startMatch(room);
    } else {
      room.phase = 'waiting';
      broadcastState(room);
    }
  });

  // 主动离开
  socket.on('leaveRoom', () => {
    handleLeave(socket, true);
  });

  socket.on('disconnect', () => {
    handleLeave(socket, false);
  });
});

function destroyRoom(room) {
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  room.players.forEach((p) => {
    if (p && p.socketId) socketIndex.delete(p.socketId);
  });
  rooms.delete(room.id);
}

function handleLeave(socket, intentional) {
  const idx = socketIndex.get(socket.id);
  if (!idx) return;
  const room = rooms.get(idx.roomId);
  socketIndex.delete(socket.id);
  if (!room) return;
  const player = room.players.find((p) => p && p.token === idx.token);
  if (!player) return;
  socket.leave(room.id);

  // 单人房间：真人离开/断线即销毁（bot 不需要宽限或通知）
  if (room.solo) {
    destroyRoom(room);
    return;
  }

  if (intentional) {
    // 主动退出：立刻移除，通知对手
    finalizeLeave(room, player);
    return;
  }

  // 断线：进入宽限，等待重连
  player.connected = false;
  player.dropAt = Date.now();
  emitRoom(room, 'opponentDisconnected', { slot: player.slot });
  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    if (player.connected) return; // 已重连
    finalizeLeave(room, player);
  }, DROP_GRACE_MS);
}

function finalizeLeave(room, player) {
  const others = room.players.filter((p) => p && p !== player && p.connected);
  player.connected = false;
  if (others.length === 0) {
    destroyRoom(room);
    return;
  }
  // 还有对手在场：通知对手离开，结束对局
  room.players[player.slot] = null;
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  room.phase = 'ended';
  room.result = { reason: 'opponentLeft' };
  emitRoom(room, 'opponentLeft', {});
  broadcastState(room);
}

// 定期清理僵尸房间（创建后长时间无人）
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (roomActivePlayers(room).length === 0 && now - room.createdAt > 60000) {
      destroyRoom(room);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`极速枪战 Arena 服务端已启动: http://localhost:${PORT}`);
  console.log(`手机访问：在同一局域网用手机浏览器打开 http://<本机IP>:${PORT}`);
});
