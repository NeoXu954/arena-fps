// world.js —— Three.js 场景、地图、光影、玩家模型、第一人称武器
// 视觉素材为 low-poly GLB（assets/models/），碰撞盒仍由 map.js 的 AABB 驱动（服务端权威）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MAP = window.ARENA_MAP;
const WEAPONS = window.ARENA_WEAPONS;
const MODEL_URL = '/assets/models/';

// 各建筑 GLB 的基准尺寸（米，X/Y/Z），必须与 gen_models.py 一致。
// 用于把模型非等比缩放到地图 AABB 的尺寸。所有模型原点在「底面中心」。
const MODEL_DIMS = {
  wall:   { x: 1.0, y: 3.0, z: 0.20 },
  crate:  { x: 0.8, y: 0.8, z: 0.80 },
  cover:  { x: 1.4, y: 0.9, z: 1.00 },
  stairs: { x: 1.0, y: 1.0, z: 1.00 },
};

// 地图 box 类型 → 使用哪个 GLB
const TYPE_TO_MODEL = {
  wall: 'wall',
  container: 'crate',
  lowwall: 'cover',
  ramp: 'stairs',
  crate: 'crate',
};

const PICKUP_VISUALS = {
  health: { color: 0x22c55e, emissive: 0x14532d },
  armor: { color: 0x38e8ff, emissive: 0x155e75 },
  ammo: { color: 0xf59e0b, emissive: 0x78350f },
  haste: { color: 0xa78bfa, emissive: 0x4c1d95 },
};

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.colliders = []; // 客户端碰撞 AABB: {min:Vec3, max:Vec3, top}
    this.remotePlayers = {}; // slot -> mesh group
    this.models = {};        // 预加载的 GLB 场景缓存
    this.modelsReady = false;
    this.activeViewWeapon = WEAPONS.defaultId;
    this.pixelRatioScale = 1;
    this.pickupNodes = new Map();

    this._initRenderer();
    this._initScene();
    this._buildGround();     // 地面 / 网格 / 出生点（同步，无 GLB）
    this._buildColliders();  // 碰撞盒（同步，始终存在）
    this._initPickups();
    this._initViewModel();   // 占位 vm 结构（同步，game.js 依赖这些引用）

    // 异步预加载 GLB，成功后替换为 3D 素材，失败则回退到方块
    this._preload()
      .then(() => { this.modelsReady = true; this._buildMapVisual(); this._populateViewModel(); })
      .catch((err) => { console.warn('[world] GLB 加载失败，回退方块素材:', err); this._buildMapVisualFallback(); });
  }

  _initRenderer() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio * this.pixelRatioScale, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;
  }

  _initScene() {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x121a2b, 30, 95);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 400);
    camera.rotation.order = 'YXZ';
    this.scene = scene;
    this.camera = camera;

    const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x3a4358, 1.15);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xdfeaff, 1.15);
    sun.position.set(28, 44, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const d = MAP.HALF + 6;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 140;
    sun.shadow.bias = -0.0008;
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x4a5c80, 0.5));

    this._buildSky();
  }

  _buildSky() {
    const geo = new THREE.SphereGeometry(200, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(0x16243f) },
        mid: { value: new THREE.Color(0x223a5e) },
        bot: { value: new THREE.Color(0x0c1322) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
        void main(){
          float h = normalize(vP).y;
          vec3 c = h > 0.0 ? mix(mid, top, h) : mix(mid, bot, -h);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  // GLB 预加载
  _preload() {
    const loader = new GLTFLoader();
    const names = ['soldier', 'rifle', 'pistol', 'wall', 'cover', 'crate', 'stairs'];
    const load = (name) => new Promise((resolve, reject) => {
      loader.load(MODEL_URL + name + '.glb',
        (gltf) => { this.models[name] = gltf.scene; resolve(); },
        undefined,
        (e) => reject(new Error(name + ': ' + e.message)));
    });
    return Promise.all(names.map(load));
  }

  _addCollider(b) {
    const top = b.cy + b.sy / 2;
    this.colliders.push({
      min: new THREE.Vector3(b.cx - b.sx / 2, b.cy - b.sy / 2, b.cz - b.sz / 2),
      max: new THREE.Vector3(b.cx + b.sx / 2, b.cy + b.sy / 2, b.cz + b.sz / 2),
      top: top,
      step: b.type === 'ramp' || top <= 1.1,
    });
  }

  // 碰撞盒（与视觉素材解耦，始终构建）
  _buildColliders() {
    MAP.walls.concat(MAP.covers).forEach((b) => this._addCollider(b));
  }

  // 地面 / 网格 / 中央圆环 / 出生点标记（同步，无 GLB）
  _buildGround() {
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x3a4560, roughness: 0.95, metalness: 0.05 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP.HALF * 2, MAP.HALF * 2), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(MAP.HALF * 2, MAP.HALF, 0x3a5a8a, 0x223049);
    grid.position.y = 0.02;
    grid.material.opacity = 0.35; grid.material.transparent = true;
    this.scene.add(grid);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 3.6, 48),
      new THREE.MeshBasicMaterial({ color: 0x38e8ff, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    this.scene.add(ring);

    MAP.spawns.forEach((sp, i) => {
      const c = i === 0 ? 0x3b82f6 : 0xef4444;
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(1.6, 32),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
      );
      m.rotation.x = -Math.PI / 2; m.position.set(sp.x, 0.04, sp.z);
      this.scene.add(m);
    });
  }

  // 用 GLB 渲染墙 / 掩体（缩放到各 AABB 尺寸；原点在底面中心）
  _buildMapVisual() {
    this._mapGroup = new THREE.Group();
    this.scene.add(this._mapGroup);
    MAP.walls.concat(MAP.covers).forEach((b) => {
      const key = TYPE_TO_MODEL[b.type] || 'crate';
      const src = this.models[key];
      if (!src) { this._addBoxMesh(b, this._mapGroup); return; }
      const dim = MODEL_DIMS[key];
      const node = src.clone(true);
      node.scale.set(b.sx / dim.x, b.sy / dim.y, b.sz / dim.z);
      node.position.set(b.cx, b.cy - b.sy / 2, b.cz);
      node.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this._mapGroup.add(node);
    });
  }

  // 回退：GLB 不可用时用原方块素材
  _buildMapVisualFallback() {
    this._mapGroup = new THREE.Group();
    this.scene.add(this._mapGroup);
    MAP.walls.concat(MAP.covers).forEach((b) => this._addBoxMesh(b, this._mapGroup));
  }

  _addBoxMesh(b, parent) {
    const matFor = (type) => {
      switch (type) {
        case 'wall': return new THREE.MeshStandardMaterial({ color: 0x39455c, roughness: 0.9, metalness: 0.1 });
        case 'container': return new THREE.MeshStandardMaterial({ color: 0x2f6f8f, roughness: 0.7, metalness: 0.25 });
        case 'lowwall': return new THREE.MeshStandardMaterial({ color: 0x4a5570, roughness: 0.85 });
        case 'ramp': return new THREE.MeshStandardMaterial({ color: 0x555f78, roughness: 0.8, metalness: 0.15 });
        default: return new THREE.MeshStandardMaterial({ color: 0x6b5a3e, roughness: 0.8 });
      }
    };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.sx, b.sy, b.sz), matFor(b.type));
    mesh.position.set(b.cx, b.cy, b.cz);
    mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh);
  }

  _initPickups() {
    this.pickupGroup = new THREE.Group();
    this.scene.add(this.pickupGroup);
  }

  _createPickupNode(pickup) {
    const visual = PICKUP_VISUALS[pickup.type] || PICKUP_VISUALS.ammo;
    const group = new THREE.Group();
    group.userData.type = pickup.type;
    group.userData.phase = Math.random() * Math.PI * 2;

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.48, 0.6, 0.14, 8),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.7, metalness: 0.35 })
    );
    base.position.y = 0.07;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.44, 0.025, 8, 24),
      new THREE.MeshBasicMaterial({ color: visual.color, transparent: true, opacity: 0.7 })
    );
    ring.name = '__pickup_ring';
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.18;
    group.add(ring);

    const mat = new THREE.MeshStandardMaterial({
      color: visual.color,
      emissive: visual.emissive,
      emissiveIntensity: 0.45,
      roughness: 0.45,
      metalness: 0.18,
    });

    const core = new THREE.Group();
    core.name = '__pickup_core';
    if (pickup.type === 'health') {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.16), mat);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.16), mat);
      core.add(a, b);
    } else if (pickup.type === 'armor') {
      core.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), mat));
    } else if (pickup.type === 'haste') {
      const bolt = new THREE.Mesh(new THREE.TetrahedronGeometry(0.34, 0), mat);
      bolt.rotation.set(0.3, 0.5, 0.2);
      core.add(bolt);
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.3), mat);
      box.rotation.y = Math.PI / 4;
      core.add(box);
    }
    core.position.y = 0.55;
    core.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    group.add(core);

    const glow = new THREE.PointLight(visual.color, 0.75, 5);
    glow.name = '__pickup_glow';
    glow.position.y = 0.75;
    group.add(glow);

    this.pickupGroup.add(group);
    return group;
  }

  updatePickups(pickups = []) {
    if (!this.pickupGroup) return;
    const seen = new Set();
    pickups.forEach((pickup) => {
      seen.add(pickup.id);
      let node = this.pickupNodes.get(pickup.id);
      if (!node) {
        node = this._createPickupNode(pickup);
        this.pickupNodes.set(pickup.id, node);
      }
      node.position.set(pickup.pos.x, pickup.pos.y || 0.35, pickup.pos.z);
      node.visible = !!pickup.active;
      node.userData.active = !!pickup.active;
    });
    for (const [id, node] of this.pickupNodes.entries()) {
      if (seen.has(id)) continue;
      this.pickupGroup.remove(node);
      this.pickupNodes.delete(id);
    }
  }

  _animatePickups() {
    if (!this.pickupGroup) return;
    const t = performance.now() * 0.001;
    this.pickupNodes.forEach((node) => {
      if (!node.visible) return;
      const phase = node.userData.phase || 0;
      const core = node.getObjectByName('__pickup_core');
      const ring = node.getObjectByName('__pickup_ring');
      if (core) {
        core.position.y = 0.55 + Math.sin(t * 2.5 + phase) * 0.08;
        core.rotation.y += 0.025;
      }
      if (ring) ring.rotation.z += 0.018;
    });
  }

  // 第一人称武器占位结构（同步创建，game.js 依赖 viewModel/muzzle/muzzleFlash/flashLight/vmBase）
  _initViewModel() {
    const vm = new THREE.Group();
    this.camera.add(vm);
    this.scene.add(this.camera);
    vm.position.set(0.22, -0.26, -0.55);

    // 枪口锚点（火光 + 子弹起点）
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.02, -0.62);
    vm.add(muzzle);
    this.muzzle = muzzle;

    // 枪口火光
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0 })
    );
    flash.position.copy(muzzle.position);
    vm.add(flash);
    this.muzzleFlash = flash;

    const flashLight = new THREE.PointLight(0xffb24a, 0, 6);
    flashLight.position.copy(muzzle.position);
    vm.add(flashLight);
    this.flashLight = flashLight;

    this.viewModel = vm;
    this.vmBase = vm.position.clone();

    // 加载前先放一个简易方块枪，避免空手；加载完成后由 _populateViewModel 替换
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.5, metalness: 0.7 });
    const tmp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.62), metal);
    tmp.name = '__tmpgun';
    vm.add(tmp);
  }

  // GLB 加载完成后：用 rifle.glb 替换第一人称武器
  _populateViewModel() {
    const vm = this.viewModel;
    const tmp = vm.getObjectByName('__tmpgun');
    if (tmp) vm.remove(tmp);
    this.setViewWeapon(this.activeViewWeapon || WEAPONS.defaultId);

    // 第一人称手臂：一对军绿手臂握住步枪，消除枪悬空的空隙
    const armMat = new THREE.MeshStandardMaterial({ color: 0x3a4a2c, roughness: 0.85 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.7 });
    const mkArm = (fx, fy, fz, rot, len) => {
      const arm = new THREE.Group();
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, len, 8), armMat);
      fore.rotation.x = Math.PI / 2; // 顺 Z 轴伸向枪
      fore.position.set(0, 0, len / 2 - 0.02);
      fore.frustumCulled = false;
      arm.add(fore);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.08), gloveMat);
      hand.position.set(0, 0, len - 0.02);
      hand.frustumCulled = false;
      arm.add(hand);
      arm.position.set(fx, fy, fz);
      arm.rotation.set(rot[0], rot[1], rot[2]);
      vm.add(arm);
      return arm;
    };
    // 右手（扳机手，靠后）+ 左手（前握，靠前），抬高到枪身高度贴合握持
    mkArm(0.03, -0.02, 0.28, [0.35, -0.05, 0], 0.24);
    mkArm(-0.03, -0.02, -0.16, [-0.15, 0.12, 0], 0.28);
  }

  setViewWeapon(weaponId) {
    const cfg = WEAPONS.byId[weaponId] || WEAPONS.byId[WEAPONS.defaultId];
    this.activeViewWeapon = cfg.id;
    if (this.muzzle) {
      this.muzzle.position.set(0, 0.02, cfg.muzzleZ);
      this.muzzleFlash.position.copy(this.muzzle.position);
      this.flashLight.position.copy(this.muzzle.position);
    }
    if (!this.viewModel || !this.models[cfg.id]) return;
    if (this.gunModel) {
      this.viewModel.remove(this.gunModel);
      this.gunModel = null;
    }
    const gun = this.models[cfg.id].clone(true);
    gun.scale.setScalar(cfg.viewScale || 1);
    gun.rotation.set(0, 0, 0);
    gun.position.set(cfg.viewPos.x, cfg.viewPos.y, cfg.viewPos.z);
    gun.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    this.viewModel.add(gun);
    this.gunModel = gun;
  }

  _makeRemoteWeapon(weaponId) {
    const cfg = WEAPONS.byId[weaponId] || WEAPONS.byId[WEAPONS.defaultId];
    if (!this.models[cfg.id]) return null;
    const weapon = this.models[cfg.id].clone(true);
    weapon.name = '__remote_weapon';
    weapon.scale.setScalar(cfg.remoteScale || 1);
    weapon.rotation.set(0, Math.PI, 0);
    weapon.position.set(cfg.remotePos.x, cfg.remotePos.y, cfg.remotePos.z);
    weapon.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return weapon;
  }

  setRemoteWeapon(slot, weaponId) {
    const g = this.remotePlayers[slot];
    if (!g || !g.userData || !g.userData.weaponMount) return;
    if (g.userData.weaponId === weaponId) return;
    if (g.userData.weaponNode) g.userData.weaponMount.remove(g.userData.weaponNode);
    const weapon = this._makeRemoteWeapon(weaponId);
    if (weapon) {
      g.userData.weaponMount.add(weapon);
      g.userData.weaponNode = weapon;
      g.userData.weaponId = weaponId;
    }
  }

  // 创建远程玩家模型（soldier.glb + 队伍配色 + 手持 rifle）
  createRemotePlayer(slot, color) {
    if (this.remotePlayers[slot]) return this.remotePlayers[slot];
    const g = new THREE.Group();

    if (this.models.soldier) {
      // 内层容器：把模型原生朝向对齐到「正面朝 +Z」（game.js 约定）
      const inner = new THREE.Group();
      inner.rotation.y = Math.PI; // 素材正面朝 -Z，转 180° 使其朝 +Z
      const body = this.models.soldier.clone(true);
      const teamCol = new THREE.Color(color);
      body.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        // 逐实例克隆材质并按队伍上色（护甲/布料向队色偏移，面罩用队色自发光）
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        o.material = mats.map((m) => {
          const nm = m.clone();
          const name = (m.name || '').toLowerCase();
          if (name.includes('armor') || name.includes('cloth')) {
            nm.color.lerp(teamCol, 0.45);
          }
          if (name.includes('accent')) {
            nm.emissive = teamCol.clone();
            nm.emissiveIntensity = 0.7;
          }
          return nm;
        });
        o.material = Array.isArray(o.material) && o.material.length === 1 ? o.material[0] : o.material;
      });
      inner.add(body);

      g.add(inner);
      // dummy 关节，兼容 game.js 的走路动画调用（GLB 为整体网格，不做腿部摆动）
      g.userData = {
        head: new THREE.Object3D(),
        torso: new THREE.Object3D(),
        lLeg: new THREE.Object3D(),
        rLeg: new THREE.Object3D(),
        gun: new THREE.Object3D(),
        weaponMount: inner,
        weaponNode: null,
        weaponId: null,
        walkPhase: 0,
      };
      this.remotePlayers[slot] = g;
      this.setRemoteWeapon(slot, WEAPONS.defaultId);
    } else {
      // 回退：方块玩家
      this._buildBoxPlayer(g, color);
    }

    g.visible = false;
    this.scene.add(g);
    this.remotePlayers[slot] = g;
    return g;
  }

  // 回退方块玩家（与旧版一致）
  _buildBoxPlayer(g, color) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.7 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.7, 6, 12), mat);
    torso.position.y = 1.0; torso.castShadow = true; g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), mat);
    head.position.y = 1.62; head.castShadow = true; g.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), new THREE.MeshStandardMaterial({ color: 0x0a1018, metalness: 0.6, roughness: 0.2, emissive: color, emissiveIntensity: 0.25 }));
    visor.position.set(0, 1.64, 0.22); g.add(visor);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.55), dark);
    gun.position.set(0.28, 1.1, 0.18); g.add(gun);
    const legGeo = new THREE.CapsuleGeometry(0.14, 0.5, 4, 8);
    const lLeg = new THREE.Mesh(legGeo, dark); lLeg.position.set(-0.16, 0.4, 0); lLeg.castShadow = true; g.add(lLeg);
    const rLeg = new THREE.Mesh(legGeo, dark); rLeg.position.set(0.16, 0.4, 0); rLeg.castShadow = true; g.add(rLeg);
    g.userData = { head, torso, lLeg, rLeg, gun, walkPhase: 0 };
  }

  removeRemotePlayer(slot) {
    const g = this.remotePlayers[slot];
    if (g) { this.scene.remove(g); delete this.remotePlayers[slot]; }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * this.pixelRatioScale, 2));
  }

  setQuality(scale) {
    this.pixelRatioScale = Math.max(0.6, Math.min(1.4, Number(scale) || 1));
    const ratio = Math.min(window.devicePixelRatio * this.pixelRatioScale, 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render() {
    this._animatePickups();
    this.renderer.render(this.scene, this.camera);
  }
}
