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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 8000,
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---------------------------------------------------------------------------
// 游戏常量
// ---------------------------------------------------------------------------
const MAX_HP = 100;
const DAMAGE = 20;
const MAG_SIZE = 30;
const RELOAD_MS = 1500;
const RESPAWN_MS = 3000;
const INVULN_MS = 1000;
const COUNTDOWN_MS = 3000;
const MATCH_MS = 180000;   // 3 分钟
const OVERTIME_MS = 30000; // 加时 30 秒
const SHOT_COOLDOWN_MS = 90; // 服务端射速上限（防连点作弊）
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

function makePlayer(slot) {
  const sp = MAP.spawns[slot];
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
    ammo: MAG_SIZE,
    reloading: false,
    reloadEnd: 0,
    alive: true,
    score: 0,
    respawnAt: 0,
    invulnUntil: 0,
    lastShot: 0,
    connected: false,
    dropAt: 0,
  };
}

function createRoom() {
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
  };
  rooms.set(id, room);
  return room;
}

function roomActivePlayers(room) {
  return room.players.filter((p) => p && p.connected);
}

function publicPlayer(p) {
  return {
    slot: p.slot,
    color: p.color,
    name: p.name,
    hp: p.hp,
    ammo: p.ammo,
    reloading: p.reloading,
    alive: p.alive,
    score: p.score,
    connected: p.connected,
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
  p.ammo = MAG_SIZE;
  p.reloading = false;
  p.alive = true;
  p.invulnUntil = Date.now() + INVULN_MS;
}

function startMatch(room) {
  room.players.forEach((p) => {
    if (!p) return;
    p.score = 0;
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
  room.result = result;
  emitRoom(room, 'gameOver', { result, players: room.players.filter(Boolean).map(publicPlayer) });
  broadcastState(room);
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
}

function gameTick(room) {
  const now = Date.now();
  room.tick++;

  // 复活处理
  room.players.forEach((p) => {
    if (!p) return;
    if (!p.alive && p.respawnAt && now >= p.respawnAt) {
      spawnPlayer(p);
      p.respawnAt = 0;
      emitRoom(room, 'respawn', { slot: p.slot, pos: p.pos, yaw: p.yaw, invulnUntil: p.invulnUntil });
    }
    // 换弹完成
    if (p.reloading && now >= p.reloadEnd) {
      p.reloading = false;
      p.ammo = MAG_SIZE;
      if (p.socketId) io.to(p.socketId).emit('reloaded', { ammo: p.ammo });
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

  // 权威快照
  if (room.tick % SNAPSHOT_EVERY === 0) {
    const players = room.players.filter(Boolean).map((p) => ({
      slot: p.slot, hp: p.hp, ammo: p.ammo, reloading: p.reloading,
      alive: p.alive, score: p.score, connected: p.connected,
      respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - now),
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
  if (killer) killer.score += 1;
  emitRoom(room, 'kill', {
    killer: killer ? killer.slot : -1,
    victim: victim.slot,
    scores: room.players.filter(Boolean).map((p) => p.score),
  });

  // 加时赛：先击杀者直接获胜
  if (room.phase === 'overtime' && killer) {
    endMatch(room);
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
      slot: p.slot, pos: p.pos, yaw: p.yaw, pitch: p.pitch, moving: p.moving,
    });
  });

  // 射击（服务端裁决命中）
  socket.on('shoot', (data) => {
    const room = currentRoom();
    const shooter = currentPlayer();
    if (!room || !shooter) return;
    if (room.phase !== 'playing' && room.phase !== 'overtime') return;
    if (!shooter.alive || shooter.reloading || shooter.ammo <= 0) return;
    const now = Date.now();
    if (now - shooter.lastShot < SHOT_COOLDOWN_MS) return;
    shooter.lastShot = now;
    shooter.ammo -= 1;

    const origin = { x: shooter.pos.x, y: shooter.pos.y, z: shooter.pos.z };
    const dir = normalize(data && data.dir ? data.dir : { x: 0, y: 0, z: -1 });

    // 让对手看到开火（弹道/枪口火光）
    socket.to(room.id).emit('oppShot', { slot: shooter.slot, origin, dir });

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
          target.hp = Math.max(0, target.hp - DAMAGE);
          const point = {
            x: origin.x + dir.x * tPlayer,
            y: origin.y + dir.y * tPlayer,
            z: origin.z + dir.z * tPlayer,
          };
          hitInfo = { tPlayer, point };
          emitRoom(room, 'hit', {
            attacker: shooter.slot, victim: target.slot, hp: target.hp, point, dmg: DAMAGE,
          });
          if (target.hp <= 0) applyKill(room, shooter, target);
        }
      }
    }

    // 通知射手命中反馈 + 弹药
    if (shooter.socketId) {
      io.to(shooter.socketId).emit('shotResult', {
        ammo: shooter.ammo, hit: !!hitInfo, kill: hitInfo && target && target.hp <= 0,
      });
    }
    // 弹药打空自动提示
    if (shooter.ammo <= 0 && shooter.socketId) {
      io.to(shooter.socketId).emit('emptyMag', {});
    }
  });

  // 换弹（服务端计时）
  socket.on('reload', () => {
    const p = currentPlayer();
    if (!p || !p.alive || p.reloading || p.ammo >= MAG_SIZE) return;
    p.reloading = true;
    p.reloadEnd = Date.now() + RELOAD_MS;
    if (p.socketId) io.to(p.socketId).emit('reloadStart', { duration: RELOAD_MS });
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
