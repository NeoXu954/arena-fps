// effects.js —— 弹道、命中火花/尘土、枪口火光等轻量特效（控制粒子数量，移动端友好）
import * as THREE from 'three';

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.active = []; // 活动特效 {update(dt)->bool}
    this._tracerMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.9 });
    this._tracerGeo = new THREE.CylinderGeometry(0.015, 0.015, 1, 5, 1, true);
  }

  // 弹道光迹：从 origin 沿 dir 画一条会快速淡出的光柱
  tracer(origin, dir, length = 60) {
    const mat = this._tracerMat.clone();
    const mesh = new THREE.Mesh(this._tracerGeo, mat);
    const end = new THREE.Vector3().copy(dir).multiplyScalar(length).add(origin);
    const mid = new THREE.Vector3().addVectors(origin, end).multiplyScalar(0.5);
    mesh.position.copy(mid);
    mesh.scale.y = length;
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.scene.add(mesh);
    let life = 0.12;
    this.active.push({
      update: (dt) => {
        life -= dt;
        mat.opacity = Math.max(0, (life / 0.12) * 0.9);
        if (life <= 0) { this.scene.remove(mesh); mat.dispose(); return false; }
        return true;
      },
    });
  }

  // 枪口火光（用于远程玩家开火）
  muzzleFlash(pos) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffcf73, transparent: true, opacity: 0.95 })
    );
    m.position.copy(pos);
    this.scene.add(m);
    const light = new THREE.PointLight(0xffb24a, 3, 7);
    light.position.copy(pos);
    this.scene.add(light);
    let life = 0.08;
    this.active.push({
      update: (dt) => {
        life -= dt;
        const k = Math.max(0, life / 0.08);
        m.material.opacity = k; m.scale.setScalar(1 + (1 - k) * 1.5);
        light.intensity = 3 * k;
        if (life <= 0) { this.scene.remove(m); this.scene.remove(light); m.material.dispose(); return false; }
        return true;
      },
    });
  }

  // 命中/弹着点火花 + 尘土
  impact(point, color = 0xffd27a) {
    const count = 8; // 控制粒子数量
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = [];
    for (let i = 0; i < count; i++) {
      pos[i * 3] = point.x; pos[i * 3 + 1] = point.y; pos[i * 3 + 2] = point.z;
      vel.push(new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 3 + 1,
        (Math.random() - 0.5) * 4
      ));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.12, transparent: true, opacity: 1, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    this.scene.add(pts);
    let life = 0.4;
    this.active.push({
      update: (dt) => {
        life -= dt;
        const arr = geo.attributes.position.array;
        for (let i = 0; i < count; i++) {
          vel[i].y -= 9 * dt; // 重力
          arr[i * 3] += vel[i].x * dt;
          arr[i * 3 + 1] += vel[i].y * dt;
          arr[i * 3 + 2] += vel[i].z * dt;
        }
        geo.attributes.position.needsUpdate = true;
        mat.opacity = Math.max(0, life / 0.4);
        if (life <= 0) { this.scene.remove(pts); geo.dispose(); mat.dispose(); return false; }
        return true;
      },
    });
  }

  // 命中敌人血雾
  bloodHit(point) {
    this.impact(point, 0xff5a5a);
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (!this.active[i].update(dt)) this.active.splice(i, 1);
    }
  }
}
