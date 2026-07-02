// game.js —— 核心对战逻辑：第一人称物理 / 射击 / 命中反馈 / 远程玩家同步 / 渲染循环
import * as THREE from 'three';

const MAP = window.ARENA_MAP;
const EYE = MAP.EYE_HEIGHT;
const PH = MAP.PLAYER_HEIGHT;
const RAD = MAP.PLAYER_RADIUS;

const SPEED = 6.2;
const GRAVITY = 22;
const JUMP_V = 7.2;
const FIRE_INTERVAL = 0.12;   // 秒/发（射速适中）
const MAG = 30;
const SPREAD = 0.014;          // 子弹散布
const STEP_TOL = 0.4;          // 上台阶容差

export class Game {
  constructor({ world, net, input, audio, effects, ui }) {
    this.world = world;
    this.net = net;
    this.input = input;
    this.audio = audio;
    this.fx = effects;
    this.ui = ui;

    this.slot = 0;
    this.phase = 'waiting';
    this.running = false;

    // 本地玩家状态
    this.pos = new THREE.Vector3(0, 0, 0); // 脚部
    this.vy = 0;
    this.grounded = true;
    this.yaw = 0;
    this.pitch = 0;
    this.recoil = 0;
    this.alive = true;
    this.invulnUntil = 0;

    this.ammo = MAG;
    this.reloading = false;
    this.lastFire = 0;

    // 远程玩家插值目标
    this.opp = null; // {slot, target:{pos,yaw,pitch,moving}, group}

    this._tmpDir = new THREE.Vector3();
    this._clock = new THREE.Clock();
    this._moveAccum = 0;
    this._stepAccum = 0;

    this._wireNet();
  }

  // 进入对局：设置出生点
  enter(slot) {
    this.slot = slot;
    const sp = MAP.spawns[slot];
    this.pos.set(sp.x, 0, sp.z);
    this.vy = 0; this.yaw = sp.yaw; this.pitch = 0;
    this.alive = true; this.ammo = MAG; this.reloading = false;
    this._syncCamera();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._clock.start();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() { this.running = false; }

  // ---------------------------------------------------------------- 网络
  _wireNet() {
    const net = this.net;
    net.on('snapshot', (s) => this._applySnapshot(s));
    net.on('oppState', (d) => this._applyOppState(d));
    net.on('oppShot', (d) => this._onOppShot(d));
    net.on('hit', (d) => this._onHit(d));
    net.on('kill', (d) => this._onKill(d));
    net.on('respawn', (d) => this._onRespawn(d));
    net.on('reloadStart', (d) => this._onReloadStart(d));
    net.on('reloaded', (d) => { this.ammo = d.ammo; this.reloading = false; this.ui.setAmmo(this.ammo, MAG, false); });
    net.on('shotResult', (d) => {
      this.ammo = d.ammo;
      this.ui.setAmmo(this.ammo, MAG, this.reloading);
    });
    net.on('emptyMag', () => { this.ui.toast('弹匣已空，请换弹'); });
  }

  _applySnapshot(s) {
    this.phase = s.phase;
    this.ui.setTimer(s.timeLeft, s.phase);
    const me = s.players.find((p) => p.slot === this.slot);
    const op = s.players.find((p) => p.slot !== this.slot);
    if (me) {
      this.ui.setHP('me', me.hp);
      this.ui.setScore(this.slot === 0 ? [me.score, op ? op.score : 0] : [op ? op.score : 0, me.score], this.slot);
      // 死亡 / 复活倒计时
      if (!me.alive) {
        this.alive = false;
        this.ui.showDeath(Math.ceil(me.respawnIn / 1000));
      }
    }
    if (op) {
      this.ui.setHP('op', op.hp);
      if (!op.connected) this.ui.toast('对手连接中…');
    }
  }

  _applyOppState(d) {
    if (!this.opp || this.opp.slot !== d.slot) {
      const color = d.slot === 0 ? 0x3b82f6 : 0xef4444;
      const group = this.world.createRemotePlayer(d.slot, color);
      this.opp = { slot: d.slot, group, target: null, cur: null };
    }
    this.opp.target = { pos: d.pos, yaw: d.yaw, pitch: d.pitch, moving: d.moving };
    this.opp.group.visible = true;
    if (!this.opp.cur) {
      this.opp.cur = { pos: { ...d.pos }, yaw: d.yaw, moving: d.moving };
    }
  }

  _onOppShot(d) {
    const origin = new THREE.Vector3(d.origin.x, d.origin.y, d.origin.z);
    const dir = new THREE.Vector3(d.dir.x, d.dir.y, d.dir.z);
    this.fx.muzzleFlash(origin.clone().add(dir.clone().multiplyScalar(0.4)));
    this.fx.tracer(origin, dir, 60);
    this.audio.shoot();
  }

  _onHit(d) {
    const pt = new THREE.Vector3(d.point.x, d.point.y, d.point.z);
    this.fx.bloodHit(pt);
    if (d.victim === this.slot) {
      // 我被击中
      this.ui.damageFlash();
      this.audio.hurt();
    }
    if (d.attacker === this.slot) {
      // 我命中对手
      this.ui.hitMarker();
      this.audio.hit();
    }
  }

  _onKill(d) {
    if (d.killer === this.slot) {
      this.ui.showKill('击败 +1', false);
      this.audio.kill();
    } else if (d.victim === this.slot) {
      this.alive = false;
      this.audio.death();
    }
    if (d.scores) {
      this.ui.setScore(d.scores, this.slot);
    }
  }

  _onRespawn(d) {
    if (d.slot === this.slot) {
      this.pos.set(d.pos.x, d.pos.y - EYE, d.pos.z);
      this.vy = 0; this.yaw = d.yaw; this.pitch = 0; this.alive = true;
      this.invulnUntil = d.invulnUntil;
      this.ammo = MAG; this.reloading = false;
      this.ui.setAmmo(this.ammo, MAG, false);
      this.ui.hideDeath();
      this._syncCamera();
    }
  }

  _onReloadStart(d) {
    this.reloading = true;
    this.ui.setAmmo(this.ammo, MAG, true);
    this.audio.reload();
    this._reloadAnimEnd = performance.now() + d.duration;
  }

  // ---------------------------------------------------------------- 主循环
  _loop() {
    if (!this.running) return;
    const dt = Math.min(0.05, this._clock.getDelta());
    this._update(dt);
    this.world.render();
    requestAnimationFrame(this._loop);
  }

  _update(dt) {
    const playing = this.phase === 'playing' || this.phase === 'overtime';

    // 视角
    const look = this.input.consumeLook();
    this.yaw -= look.dx * this.input.lookSensitivity;
    this.pitch -= look.dy * this.input.lookSensitivity;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

    // 后坐力恢复
    this.recoil += (0 - this.recoil) * Math.min(1, dt * 12);

    if (this.alive && playing) {
      this._movePlayer(dt);
    } else {
      this.input.consumeReload();
      this.input.consumeJump();
    }

    // 先同步相机（位置 + 朝向），保证射击方向使用当前帧的瞄准
    this._syncCamera();

    if (this.alive && playing) {
      this._handleShooting(dt);
      if (this.input.consumeReload()) this._startReload();
    }

    this._animateViewModel(dt);
    this._updateRemote(dt);
    this.fx.update(dt);

    // 上报状态（~20Hz）
    this._moveAccum += dt;
    if (this._moveAccum >= 0.05 && this.alive) {
      this._moveAccum = 0;
      this.net.sendMove({
        pos: { x: this.pos.x, y: this.pos.y + EYE, z: this.pos.z },
        yaw: this.yaw, pitch: this.pitch,
        moving: Math.abs(this.input.move.x) + Math.abs(this.input.move.y) > 0.1,
      });
    }
  }

  _movePlayer(dt) {
    // 输入方向（相对朝向）
    const mv = this.input.move;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // 前进向量（yaw=0 朝 -Z）
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;
    let vx = (fx * mv.y + rx * mv.x) * SPEED;
    let vz = (fz * mv.y + rz * mv.x) * SPEED;

    // 跳跃
    if (this.input.consumeJump() && this.grounded) {
      this.vy = JUMP_V; this.grounded = false;
    }

    // 水平移动（分轴解算，贴墙滑动）
    this._tryMove(vx * dt, 0);
    this._tryMove(0, vz * dt);

    // 重力 + 垂直
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;

    // 地面/平台支撑
    let groundY = 0;
    for (const b of this.world.colliders) {
      if (!this._overlapXZ(this.pos.x, this.pos.z, b)) continue;
      if (b.step) {
        // 低台阶/坡道：踩上去即站立其顶部
        if (b.top > groundY) groundY = b.top;
      } else if (b.top <= this.pos.y + STEP_TOL && b.top > groundY) {
        groundY = b.top;
      }
    }
    if (this.pos.y <= groundY) {
      this.pos.y = groundY; this.vy = 0; this.grounded = true;
    } else {
      this.grounded = false;
    }

    // 边界（竞技场内）
    const lim = MAP.HALF - 1 - RAD;
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x));
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));

    // 脚步声
    const speed2 = Math.hypot(vx, vz);
    if (this.grounded && speed2 > 1) {
      this._stepAccum += dt;
      if (this._stepAccum > 0.34) { this._stepAccum = 0; this.audio.step(); }
    }
  }

  _tryMove(dx, dz) {
    const nx = this.pos.x + dx;
    const nz = this.pos.z + dz;
    if (!this._collidesBody(nx, nz)) {
      this.pos.x = nx; this.pos.z = nz;
    }
  }

  // 玩家身体是否与某掩体水平相交（考虑竖直重叠）
  _collidesBody(x, z) {
    const bodyMin = this.pos.y;
    const bodyMax = this.pos.y + PH;
    for (const b of this.world.colliders) {
      if (b.step) continue;                      // 低台阶/坡道：不做水平阻挡，可走上
      if (b.max.y <= bodyMin + 0.05) continue;   // 在脚下（可踩）
      if (b.min.y >= bodyMax) continue;          // 在头顶
      if (x + RAD > b.min.x && x - RAD < b.max.x &&
          z + RAD > b.min.z && z - RAD < b.max.z) {
        return true;
      }
    }
    return false;
  }

  _overlapXZ(x, z, b) {
    return x + RAD > b.min.x && x - RAD < b.max.x && z + RAD > b.min.z && z - RAD < b.max.z;
  }

  _handleShooting(dt) {
    if (!this.input.firing) return;
    const now = performance.now() / 1000;
    if (now - this.lastFire < FIRE_INTERVAL) return;
    if (this.reloading) return;
    if (this.ammo <= 0) { this._startReload(); return; }
    this.lastFire = now;
    this.ammo -= 1;
    this.ui.setAmmo(this.ammo, MAG, false);

    // 朝向 + 散布
    this.world.camera.getWorldDirection(this._tmpDir);
    const dir = this._tmpDir.clone();
    dir.x += (Math.random() - 0.5) * SPREAD;
    dir.y += (Math.random() - 0.5) * SPREAD;
    dir.z += (Math.random() - 0.5) * SPREAD;
    dir.normalize();

    // 发送服务端裁决
    this.net.shoot({ x: dir.x, y: dir.y, z: dir.z });

    // 本地表现
    this._fireFeedback(dir);
  }

  _fireFeedback(dir) {
    this.audio.shoot();
    this.recoil = Math.min(0.09, this.recoil + 0.03);
    // 枪口世界坐标
    const muzzleWorld = new THREE.Vector3();
    this.world.muzzle.getWorldPosition(muzzleWorld);
    // 枪口火光
    const f = this.world.muzzleFlash; f.material.opacity = 1;
    this.world.flashLight.intensity = 2.4;
    this._flashUntil = performance.now() + 50;
    // 弹道
    this.fx.tracer(muzzleWorld, dir, 60);
    // 命中点尘土（仅墙面，避免与服务端血雾重叠）
    const origin = this.world.camera.position;
    const wallT = this._rayWall(origin, dir);
    const enemyT = this._rayEnemy(origin, dir);
    if (wallT !== Infinity && (enemyT === Infinity || wallT < enemyT)) {
      const pt = origin.clone().add(dir.clone().multiplyScalar(wallT));
      this.fx.impact(pt, 0xcfd6e0);
    }
    // 视模型后坐
    this._vmKick = 0.06;
  }

  _rayWall(o, d) {
    let best = Infinity;
    for (const b of this.world.colliders) {
      const t = this._rayAABB(o, d, b);
      if (t > 0.2 && t < best) best = t;
    }
    return best;
  }

  _rayEnemy(o, d) {
    if (!this.opp || !this.opp.group.visible) return Infinity;
    const g = this.opp.group;
    const px = g.position.x, pz = g.position.z;
    const feetY = g.position.y, topY = feetY + PH;
    const ox = o.x - px, oz = o.z - pz;
    const a = d.x * d.x + d.z * d.z; if (a < 1e-6) return Infinity;
    const b = 2 * (d.x * ox + d.z * oz);
    const c = ox * ox + oz * oz - RAD * RAD;
    const disc = b * b - 4 * a * c; if (disc < 0) return Infinity;
    const sq = Math.sqrt(disc);
    let t = (-b - sq) / (2 * a); if (t < 0) t = (-b + sq) / (2 * a);
    if (t < 0) return Infinity;
    const y = o.y + d.y * t;
    if (y < feetY || y > topY) return Infinity;
    return t;
  }

  _rayAABB(o, d, b) {
    let tmin = -Infinity, tmax = Infinity;
    const ax = [[o.x, d.x, b.min.x, b.max.x], [o.y, d.y, b.min.y, b.max.y], [o.z, d.z, b.min.z, b.max.z]];
    for (const [oo, dd, lo, hi] of ax) {
      if (Math.abs(dd) < 1e-8) { if (oo < lo || oo > hi) return Infinity; }
      else {
        let t1 = (lo - oo) / dd, t2 = (hi - oo) / dd;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return Infinity;
      }
    }
    if (tmax < 0) return Infinity;
    return tmin > 0 ? tmin : 0;
  }

  _startReload() {
    if (this.reloading || this.ammo >= MAG || !this.alive) return;
    this.net.reload();
    this.reloading = true;
    this.ui.setAmmo(this.ammo, MAG, true);
    this.audio.reload();
  }

  _syncCamera() {
    const cam = this.world.camera;
    cam.position.set(this.pos.x, this.pos.y + EYE, this.pos.z);
    cam.rotation.y = this.yaw;
    cam.rotation.x = this.pitch - this.recoil;
  }

  _animateViewModel(dt) {
    const vm = this.world.viewModel;
    if (!vm) return;
    const base = this.world.vmBase;
    // 后坐恢复
    this._vmKick = (this._vmKick || 0) * (1 - Math.min(1, dt * 10));
    // 移动摆动
    const moving = this.alive && (Math.abs(this.input.move.x) + Math.abs(this.input.move.y) > 0.1) && this.grounded;
    this._bob = (this._bob || 0) + dt * (moving ? 10 : 0);
    const bobX = Math.cos(this._bob) * 0.006 * (moving ? 1 : 0);
    const bobY = Math.abs(Math.sin(this._bob)) * 0.008 * (moving ? 1 : 0);
    vm.position.set(base.x + bobX, base.y - bobY, base.z + (this._vmKick || 0));
    // 换弹动画：枪下沉
    if (this.reloading) {
      vm.position.y -= 0.12;
      vm.rotation.x = 0.5;
    } else {
      vm.rotation.x += (0 - vm.rotation.x) * Math.min(1, dt * 10);
    }
    // 枪口火光熄灭
    if (this._flashUntil && performance.now() > this._flashUntil) {
      this.world.muzzleFlash.material.opacity = 0;
      this.world.flashLight.intensity = 0;
      this._flashUntil = 0;
    }
  }

  _updateRemote(dt) {
    if (!this.opp || !this.opp.target) return;
    const { group, target, cur } = this.opp;
    // 平滑插值
    const k = Math.min(1, dt * 14);
    cur.pos.x += (target.pos.x - cur.pos.x) * k;
    cur.pos.y += (target.pos.y - cur.pos.y) * k;
    cur.pos.z += (target.pos.z - cur.pos.z) * k;
    // yaw 角度插值（取最短路径）
    let dy = target.yaw - cur.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    cur.yaw += dy * k;
    cur.moving = target.moving;

    group.position.set(cur.pos.x, cur.pos.y - EYE, cur.pos.z);
    group.rotation.y = cur.yaw + Math.PI; // 模型正面朝 +Z，朝向取反
    // 走路腿部摆动
    const ud = group.userData;
    if (cur.moving) {
      ud.walkPhase += dt * 9;
      ud.lLeg.rotation.x = Math.sin(ud.walkPhase) * 0.5;
      ud.rLeg.rotation.x = -Math.sin(ud.walkPhase) * 0.5;
    } else {
      ud.lLeg.rotation.x *= 0.85; ud.rLeg.rotation.x *= 0.85;
    }
  }
}
