// world.js —— Three.js 场景、地图、光影、玩家模型、第一人称武器
import * as THREE from 'three';

const MAP = window.ARENA_MAP;

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.colliders = []; // 客户端碰撞 AABB: {min:Vec3, max:Vec3, top}
    this.remotePlayers = {}; // slot -> mesh group
    this._initRenderer();
    this._initScene();
    this._buildMap();
    this._initViewModel();
  }

  _initRenderer() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

    // 第一人称相机
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 400);
    camera.rotation.order = 'YXZ';
    this.scene = scene;
    this.camera = camera;

    // 武器单独放到相机里的子场景层（避免被环境遮挡），用普通子物体即可
    // 光照：半球环境光 + 主方向光（投影）
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

  // 渐变天空盒（轻量 shader 大球）
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

  _addCollider(b) {
    const top = b.cy + b.sy / 2;
    this.colliders.push({
      min: new THREE.Vector3(b.cx - b.sx / 2, b.cy - b.sy / 2, b.cz - b.sz / 2),
      max: new THREE.Vector3(b.cx + b.sx / 2, b.cy + b.sy / 2, b.cz + b.sz / 2),
      top: top,
      // 低矮平台/坡道：可直接走上去（不做水平阻挡，仅提供站立支撑）
      step: b.type === 'ramp' || top <= 1.1,
    });
  }

  _buildMap() {
    // 地面
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x3a4560, roughness: 0.95, metalness: 0.05 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP.HALF * 2, MAP.HALF * 2), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 地面网格纹理（科幻竞技感）
    const grid = new THREE.GridHelper(MAP.HALF * 2, MAP.HALF, 0x3a5a8a, 0x223049);
    grid.position.y = 0.02;
    grid.material.opacity = 0.35; grid.material.transparent = true;
    this.scene.add(grid);

    // 中央高亮圆环
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 3.6, 48),
      new THREE.MeshBasicMaterial({ color: 0x38e8ff, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    this.scene.add(ring);

    // 材质按类型
    const matFor = (type) => {
      switch (type) {
        case 'wall': return new THREE.MeshStandardMaterial({ color: 0x39455c, roughness: 0.9, metalness: 0.1 });
        case 'container': return new THREE.MeshStandardMaterial({ color: 0x2f6f8f, roughness: 0.7, metalness: 0.25 });
        case 'lowwall': return new THREE.MeshStandardMaterial({ color: 0x4a5570, roughness: 0.85 });
        case 'ramp': return new THREE.MeshStandardMaterial({ color: 0x555f78, roughness: 0.8, metalness: 0.15 });
        default: return new THREE.MeshStandardMaterial({ color: 0x6b5a3e, roughness: 0.8 });
      }
    };

    // 墙 + 掩体
    MAP.walls.concat(MAP.covers).forEach((b) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.sx, b.sy, b.sz), matFor(b.type));
      mesh.position.set(b.cx, b.cy, b.cz);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.scene.add(mesh);
      // 集装箱加一点描边色带
      if (b.type === 'container') {
        const edge = new THREE.Mesh(
          new THREE.BoxGeometry(b.sx * 1.001, 0.18, b.sz * 1.001),
          new THREE.MeshBasicMaterial({ color: 0x38e8ff })
        );
        edge.position.set(b.cx, b.cy + b.sy / 2 - 0.2, b.cz);
        this.scene.add(edge);
      }
      this._addCollider(b);
    });

    // 出生点标记（红蓝）
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

  // 第一人称武器 + 手臂（挂在相机上）
  _initViewModel() {
    const vm = new THREE.Group();
    this.camera.add(vm);
    this.scene.add(this.camera);
    vm.position.set(0.22, -0.26, -0.55);

    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.5, metalness: 0.7 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x38e8ff, emissive: 0x0a6273, emissiveIntensity: 0.6, roughness: 0.4 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x6b7d52, roughness: 0.85 }); // 军绿手套/袖子

    // 枪身
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.62), metal);
    body.position.set(0, 0, 0); vm.add(body);
    // 枪管
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.5, 10), metal);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.5); vm.add(barrel);
    // 弹匣
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.12), metal);
    mag.position.set(0, -0.16, 0.05); vm.add(mag);
    this.magMesh = mag;
    // 瞄准镜/光条
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), accent);
    sight.position.set(0, 0.11, -0.05); vm.add(sight);
    // 枪托
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.18), metal);
    stock.position.set(0, -0.02, 0.34); vm.add(stock);

    // 手臂（右手握把 + 左手前握）
    const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.28), skin);
    rArm.position.set(0.02, -0.14, 0.22); rArm.rotation.x = -0.5; vm.add(rArm);
    const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.26), skin);
    lArm.position.set(-0.05, -0.12, -0.28); lArm.rotation.x = 0.7; lArm.rotation.y = 0.2; vm.add(lArm);

    // 枪口（火光与子弹起点）
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.02, -0.76);
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
  }

  // 创建远程玩家模型
  createRemotePlayer(slot, color) {
    if (this.remotePlayers[slot]) return this.remotePlayers[slot];
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.7 });

    // 躯干（胶囊）
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.7, 6, 12), mat);
    torso.position.y = 1.0; torso.castShadow = true; g.add(torso);
    // 头
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), mat);
    head.position.y = 1.62; head.castShadow = true; g.add(head);
    // 面罩
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), new THREE.MeshStandardMaterial({ color: 0x0a1018, metalness: 0.6, roughness: 0.2, emissive: color, emissiveIntensity: 0.25 }));
    visor.position.set(0, 1.64, 0.22); g.add(visor);
    // 枪（第三人称）
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.55), dark);
    gun.position.set(0.28, 1.1, 0.18); g.add(gun);
    // 腿
    const legGeo = new THREE.CapsuleGeometry(0.14, 0.5, 4, 8);
    const lLeg = new THREE.Mesh(legGeo, dark); lLeg.position.set(-0.16, 0.4, 0); lLeg.castShadow = true; g.add(lLeg);
    const rLeg = new THREE.Mesh(legGeo, dark); rLeg.position.set(0.16, 0.4, 0); rLeg.castShadow = true; g.add(rLeg);
    g.userData = { head, torso, lLeg, rLeg, gun, walkPhase: 0 };

    g.visible = false;
    this.scene.add(g);
    this.remotePlayers[slot] = g;
    return g;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
