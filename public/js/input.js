// input.js —— 移动端触控（虚拟摇杆 / 滑动转向 / 射击换弹跳跃）+ 桌面键鼠（便于测试）
export class Input {
  constructor() {
    this.move = { x: 0, y: 0 };   // x: 横移(-1左,1右)  y: 前后(1前,-1后)
    this.lookDX = 0;              // 本帧累计的视角水平位移（像素）
    this.lookDY = 0;              // 本帧累计的视角垂直位移（像素）
    this.firing = false;
    this._jumpQueued = false;
    this._reloadQueued = false;
    this.lookSensitivity = 0.0042; // 弧度/像素

    this._joyId = null;
    this._lookId = null;
    this._joyCenter = { x: 0, y: 0 };
    this._joyRadius = 56;

    this._setupJoystick();
    this._setupLook();
    this._setupButtons();
    this._setupKeyboard();
  }

  consumeJump() { const j = this._jumpQueued; this._jumpQueued = false; return j; }
  consumeReload() { const r = this._reloadQueued; this._reloadQueued = false; return r; }
  consumeLook() {
    const dx = this.lookDX, dy = this.lookDY;
    this.lookDX = 0; this.lookDY = 0;
    return { dx, dy };
  }

  _setupJoystick() {
    const joy = document.getElementById('joystick');
    const knob = document.getElementById('joystick-knob');
    const rectCenter = () => {
      const r = joy.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const start = (id, x, y) => {
      this._joyId = id;
      this._joyCenter = rectCenter();
      this._updateJoy(x, y, knob);
    };
    const updateGlobal = (x, y) => this._updateJoy(x, y, knob);
    const end = () => {
      this._joyId = null; this.move.x = 0; this.move.y = 0;
      knob.style.transform = 'translate(-50%, -50%)';
    };

    joy.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      start(t.identifier, t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener('touchmove', (e) => {
      if (this._joyId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === this._joyId) { updateGlobal(t.clientX, t.clientY); }
      }
    }, { passive: false });
    document.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) if (t.identifier === this._joyId) end();
    });
    document.addEventListener('touchcancel', (e) => {
      for (const t of e.changedTouches) if (t.identifier === this._joyId) end();
    });
  }

  _updateJoy(x, y, knob) {
    let dx = x - this._joyCenter.x;
    let dy = y - this._joyCenter.y;
    const dist = Math.hypot(dx, dy);
    const r = this._joyRadius;
    if (dist > r) { dx = (dx / dist) * r; dy = (dy / dist) * r; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.move.x = dx / r;
    this.move.y = -dy / r; // 向上为前进
  }

  _setupLook() {
    const canvas = document.getElementById('game-canvas');
    let lastX = 0, lastY = 0;
    canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        // 仅右侧区域作为视角控制，避免与摇杆冲突
        if (this._lookId === null && t.clientX > window.innerWidth * 0.34) {
          this._lookId = t.identifier; lastX = t.clientX; lastY = t.clientY;
        }
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._lookId) {
          this.lookDX += t.clientX - lastX;
          this.lookDY += t.clientY - lastY;
          lastX = t.clientX; lastY = t.clientY;
        }
      }
    }, { passive: false });
    const endLook = (e) => {
      for (const t of e.changedTouches) if (t.identifier === this._lookId) this._lookId = null;
    };
    canvas.addEventListener('touchend', endLook);
    canvas.addEventListener('touchcancel', endLook);

    // 桌面：指针锁定鼠标转向
    canvas.addEventListener('click', () => {
      if (!('ontouchstart' in window) && document.body.classList.contains('in-game')) {
        canvas.requestPointerLock && canvas.requestPointerLock();
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) {
        this.lookDX += e.movementX; this.lookDY += e.movementY;
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement === canvas && e.button === 0) this.firing = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
    });
  }

  _bindButton(el, onDown, onUp) {
    if (!el) return;
    const down = (e) => { e.preventDefault(); e.stopPropagation(); onDown && onDown(); };
    const up = (e) => { e.preventDefault(); e.stopPropagation(); onUp && onUp(); };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
  }

  _setupButtons() {
    this._bindButton(document.getElementById('btn-fire'),
      () => { this.firing = true; }, () => { this.firing = false; });
    this._bindButton(document.getElementById('btn-reload'),
      () => { this._reloadQueued = true; });
    this._bindButton(document.getElementById('btn-jump'),
      () => { this._jumpQueued = true; });
  }

  _setupKeyboard() {
    const keys = this.keys = {};
    window.addEventListener('keydown', (e) => {
      keys[e.code] = true;
      if (e.code === 'KeyR') this._reloadQueued = true;
      if (e.code === 'Space') this._jumpQueued = true;
      this._applyKeys();
    });
    window.addEventListener('keyup', (e) => { keys[e.code] = false; this._applyKeys(); });
  }

  _applyKeys() {
    const k = this.keys;
    if (!k) return;
    // 仅当没有摇杆触摸时由键盘驱动
    if (this._joyId !== null) return;
    let x = 0, y = 0;
    if (k['KeyW'] || k['ArrowUp']) y += 1;
    if (k['KeyS'] || k['ArrowDown']) y -= 1;
    if (k['KeyA'] || k['ArrowLeft']) x -= 1;
    if (k['KeyD'] || k['ArrowRight']) x += 1;
    const len = Math.hypot(x, y) || 1;
    this.move.x = x / len * (x || y ? 1 : 0);
    this.move.y = y / len * (x || y ? 1 : 0);
  }
}
