// audio.js —— 程序化合成音效（WebAudio），无外部资源、加载快、体积小
export class AudioFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.65;
  }

  // 首次用户交互时调用以解锁音频
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.master) this.master.gain.value = this.volume;
  }

  _noiseBuffer(dur) {
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _env(node, t0, peak, dur, gainTo = this.master) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    node.connect(g); g.connect(gainTo);
    return g;
  }

  shoot() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    // 噪声爆裂
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.18);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 0.7;
    src.connect(bp);
    this._env(bp, t, 0.55, 0.16);
    src.start(t); src.stop(t + 0.2);
    // 低频"砰"
    const osc = this.ctx.createOscillator();
    osc.type = 'square'; osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    this._env(osc, t, 0.4, 0.14);
    osc.start(t); osc.stop(t + 0.16);
  }

  hit() { // 命中敌人
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.06);
    this._env(osc, t, 0.5, 0.09);
    osc.start(t); osc.stop(t + 0.1);
  }

  hurt() { // 自己受击
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.2);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700;
    src.connect(lp); this._env(lp, t, 0.5, 0.18);
    src.start(t); src.stop(t + 0.2);
  }

  kill() { // 击败对手提示
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    [523, 659, 784].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      this._env(o, t + i * 0.07, 0.4, 0.18);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.2);
    });
  }

  death() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(330, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.5);
    this._env(o, t, 0.4, 0.55);
    o.start(t); o.stop(t + 0.6);
  }

  reload() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    // 两声机械咔哒
    [0, 0.18].forEach((dt) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer(0.05);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'highpass'; bp.frequency.value = 2500;
      src.connect(bp); this._env(bp, t + dt, 0.35, 0.05);
      src.start(t + dt); src.stop(t + dt + 0.06);
    });
  }

  step() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.06);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 350;
    src.connect(lp); this._env(lp, t, 0.18, 0.06);
    src.start(t); src.stop(t + 0.07);
  }

  victory() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1046].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = f;
      this._env(o, t + i * 0.13, 0.4, 0.3);
      o.start(t + i * 0.13); o.stop(t + i * 0.13 + 0.32);
    });
  }

  defeat() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    [392, 330, 262].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      this._env(o, t + i * 0.18, 0.35, 0.35);
      o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.38);
    });
  }
}
