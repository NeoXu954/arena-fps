/* 集成测试：模拟两名玩家，验证 创建/加入 → 倒计时 → 命中/击杀/比分 → 结束 全流程。
 * 用法：先启动服务端（PORT=3010 node server.js），再 node test/integration.js  */
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3010';

function client(name) {
  const s = io(URL, { forceNew: true, transports: ['websocket'] });
  s.name = name; s.events = [];
  ['roomState', 'snapshot', 'matchStart', 'overtime', 'gameOver', 'oppState',
   'oppShot', 'hit', 'kill', 'respawn', 'reloadStart', 'reloaded', 'shotResult',
   'emptyMag', 'weaponChanged', 'oppWeapon', 'pickup', 'pickupSpawned', 'opponentLeft'].forEach((e) => s.on(e, (d) => s.events.push({ e, d })));
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, m) { if (!c) { console.error('❌ FAIL:', m); process.exitCode = 1; } else console.log('✅', m); }

(async () => {
  const a = client('A'), b = client('B');
  await sleep(400);

  // A 创建房间
  const ra = await new Promise((r) => a.emit('createRoom', { name: 'Alice' }, r));
  assert(ra.ok && /^\d{4}$/.test(ra.roomId), '创建房间返回 4 位房间号: ' + ra.roomId);
  a.slot = ra.slot;

  // B 用错误房间号加入 → 失败
  const bad = await new Promise((r) => b.emit('joinRoom', { roomId: '0000' }, r));
  assert(!bad.ok, '加入不存在的房间被拒绝: ' + (bad.error || ''));

  // B 加入正确房间
  const rb = await new Promise((r) => b.emit('joinRoom', { roomId: ra.roomId, name: 'Bob' }, r));
  assert(rb.ok && rb.slot !== ra.slot, 'B 成功加入并分配到不同槽位');
  b.slot = rb.slot;

  // 第三个客户端加入应被拒绝（房间最多 2 人）
  const c = client('C'); await sleep(200);
  const rc = await new Promise((r) => c.emit('joinRoom', { roomId: ra.roomId }, r));
  assert(!rc.ok, '第三名玩家被拒绝（房间已满）: ' + (rc.error || ''));
  c.close();

  // 等待倒计时 → 对战开始
  await sleep(3600);
  const started = a.events.some((x) => x.e === 'matchStart');
  assert(started, '满 2 人后自动倒计时并开始对战');

  // 上报位置：A、B 互相能收到 oppState
  a.emit('move', { pos: { x: 0, y: 1.5, z: 19 }, yaw: 0, pitch: 0, moving: true });
  b.emit('move', { pos: { x: 0, y: 1.5, z: -19 }, yaw: Math.PI, pitch: 0, moving: false });
  await sleep(150);
  assert(b.events.some((x) => x.e === 'oppState'), 'B 收到 A 的位置同步');

  // A 把 B 放在正前方无遮挡侧道（x=10），直线射击命中（B 在 -Z 方向）
  a.emit('move', { pos: { x: 10, y: 1.5, z: 5 }, yaw: 0, pitch: 0, moving: false });
  b.emit('move', { pos: { x: 10, y: 1.5, z: -2 }, yaw: Math.PI, pitch: 0, moving: false });
  await sleep(150);

  // 武器切换：A 切到手枪/狙击枪再切回步枪，验证服务端同步弹匣和武器状态
  a.events.length = 0; b.events.length = 0;
  a.emit('switchWeapon', { weapon: 'pistol' });
  await sleep(120);
  assert(a.events.some((x) => x.e === 'weaponChanged' && x.d.weapon === 'pistol' && x.d.ammo === 12), 'A 切换到手枪并收到 12 发弹匣');
  assert(b.events.some((x) => x.e === 'oppWeapon' && x.d.weapon === 'pistol'), 'B 收到 A 的手枪切换同步');
  a.emit('switchWeapon', { weapon: 'sniper' });
  await sleep(120);
  assert(a.events.some((x) => x.e === 'weaponChanged' && x.d.weapon === 'sniper' && x.d.ammo === 5), 'A 切换到狙击枪并收到 5 发弹匣');
  assert(b.events.some((x) => x.e === 'oppWeapon' && x.d.weapon === 'sniper'), 'B 收到 A 的狙击枪切换同步');
  a.emit('switchWeapon', { weapon: 'rifle' });
  await sleep(120);
  assert(a.events.some((x) => x.e === 'weaponChanged' && x.d.weapon === 'rifle' && x.d.ammo === 30), 'A 切回步枪并收到 30 发弹匣');

  // A 朝 -Z 连续射击 5 次（每次 20 伤害，应在第 5 发击杀）
  a.events.length = 0; b.events.length = 0;
  for (let i = 0; i < 5; i++) {
    a.emit('shoot', { dir: { x: 0, y: 0, z: -1 } });
    await sleep(120);
  }
  await sleep(300);
  const hits = a.events.filter((x) => x.e === 'shotResult' && x.d.hit).length;
  assert(hits >= 4, `A 命中次数 >=4（实际 ${hits}）`);
  const lastHit = a.events.filter((x) => x.e === 'shotResult' && x.d.hit).pop();
  assert(lastHit && lastHit.d.stats && lastHit.d.stats.damageDealt >= 100, 'A 收到服务端命中/伤害统计');
  const kill = a.events.find((x) => x.e === 'kill');
  assert(kill && kill.d.killer === a.slot && kill.d.victim === b.slot, 'A 击杀 B，击杀事件正确');
  assert(kill && kill.d.scores[a.slot] === 1, 'A 比分 +1');

  // 遮挡：把 B 藏到 A 视线被掩体挡住的位置无法直接验证，改测背对射击不命中
  a.events.length = 0;
  a.emit('shoot', { dir: { x: 0, y: 0, z: 1 } }); // 朝 +Z，背对 B
  await sleep(200);
  const miss = a.events.find((x) => x.e === 'shotResult');
  assert(miss && !miss.d.hit, '背对方向射击未命中');

  // 换弹
  a.events.length = 0;
  a.emit('reload');
  await sleep(100);
  assert(a.events.some((x) => x.e === 'reloadStart'), '换弹开始事件');
  await sleep(1600);
  assert(a.events.some((x) => x.e === 'reloaded' && x.d.ammo === 30), '换弹完成，弹匣恢复 30');

  // B 断线 → A 收到对手离开
  a.events.length = 0;
  b.close();
  await sleep(400);
  // 断线进入宽限，A 先收到 opponentDisconnected（passthrough 未监听该事件名也无妨）
  // 等待宽限结束（10s）较久，这里只验证断线不崩服务
  const health = await fetch(URL + '/health').then((r) => r.json()).catch(() => null);
  assert(health && health.ok, '服务端在客户端断线后仍正常');

  a.close();
  await sleep(200);

  // 战术补给模式：验证补给点、护甲和补给统计
  const supply = client('Supply');
  await sleep(300);
  const rs = await new Promise((r) => supply.emit('startSolo', { name: 'Supply', difficulty: 'easy', mode: 'supply' }, r));
  assert(rs.ok && rs.mode === 'supply', '战术补给单人局创建成功');
  supply.slot = rs.slot;
  await sleep(3600);
  supply.events.length = 0;
  supply.emit('move', { pos: { x: 0, y: 1.5, z: 10 }, yaw: 0, pitch: 0, moving: false });
  await sleep(700);
  const pickup = supply.events.find((x) => x.e === 'pickup' && x.d.slot === supply.slot && x.d.type === 'armor');
  assert(pickup && pickup.d.armor > 0, '战术补给模式可拾取护甲补给');
  assert(pickup && pickup.d.stats && pickup.d.stats.pickups >= 1, '补给拾取次数被统计');
  supply.close();
  await sleep(200);

  console.log('\n集成测试完成。');
  process.exit(process.exitCode || 0);
})();
