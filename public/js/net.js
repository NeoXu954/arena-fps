// net.js —— Socket.IO 封装：房间、状态同步、断线重连
export class Net {
  constructor() {
    /* global io */
    this.socket = io({ reconnection: true, reconnectionDelay: 600, reconnectionAttempts: 20 });
    this.handlers = {};
    this.roomId = null;
    this.token = null;
    this.slot = null;
    this._wire();
  }

  on(event, fn) { this.handlers[event] = fn; }
  _emitLocal(event, data) { if (this.handlers[event]) this.handlers[event](data); }

  _wire() {
    const passthrough = [
      'roomState', 'snapshot', 'matchStart', 'countdown', 'overtime', 'gameOver',
      'oppState', 'oppShot', 'hit', 'kill', 'respawn', 'reloadStart', 'reloaded',
      'shotResult', 'emptyMag', 'weaponChanged', 'oppWeapon', 'pickup', 'pickupSpawned',
      'opponentLeft', 'opponentDisconnected', 'opponentReconnected',
    ];
    passthrough.forEach((ev) => this.socket.on(ev, (d) => this._emitLocal(ev, d)));

    this.socket.on('connect', () => {
      this._emitLocal('connected');
      // 断线重连后尝试 rejoin
      if (this.roomId && this.token) {
        this.socket.emit('rejoin', { roomId: this.roomId, token: this.token }, (res) => {
          if (res && res.ok) {
            this.slot = res.slot;
            this.mode = res.mode;
            this._emitLocal('rejoined', res);
          } else {
            this._emitLocal('rejoinFailed', res);
          }
        });
      }
    });
    this.socket.on('disconnect', () => this._emitLocal('disconnected'));
  }

  createRoom(name, mode) {
    return new Promise((resolve) => {
      this.socket.emit('createRoom', { name, mode }, (res) => {
        if (res && res.ok) {
          this.roomId = res.roomId; this.token = res.token; this.slot = res.slot; this.mode = res.mode; this.solo = false;
        }
        resolve(res);
      });
    });
  }

  joinRoom(roomId, name) {
    return new Promise((resolve) => {
      this.socket.emit('joinRoom', { roomId, name }, (res) => {
        if (res && res.ok) {
          this.roomId = res.roomId; this.token = res.token; this.slot = res.slot; this.mode = res.mode; this.solo = false;
        }
        resolve(res);
      });
    });
  }

  startSolo(name, difficulty, mode) {
    return new Promise((resolve) => {
      this.socket.emit('startSolo', { name, difficulty, mode }, (res) => {
        if (res && res.ok) {
          this.roomId = res.roomId; this.token = res.token; this.slot = res.slot;
          this.mode = res.mode;
          this.solo = true;
        }
        resolve(res);
      });
    });
  }

  leaveRoom() {
    this.socket.emit('leaveRoom');
    this.roomId = null; this.token = null; this.slot = null; this.mode = null; this.solo = false;
  }

  sendMove(state) { this.socket.emit('move', state); }
  shoot(dir) { this.socket.emit('shoot', { dir }); }
  switchWeapon(weapon) { this.socket.emit('switchWeapon', { weapon }); }
  reload() { this.socket.emit('reload'); }
  rematch() { this.socket.emit('rematch'); }
}
