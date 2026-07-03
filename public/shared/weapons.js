/*
 * Shared weapon tuning for client prediction and server-authoritative combat.
 * Units: cooldown/reload in ms, fireInterval in seconds, damage in HP.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ARENA_WEAPONS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const list = [
    {
      id: 'rifle',
      label: 'AR-30',
      role: '突击步枪',
      mag: 30,
      damage: 20,
      fireInterval: 0.12,
      cooldownMs: 90,
      reloadMs: 1500,
      spread: 0.014,
      recoil: 0.030,
      kick: 0.060,
      muzzleZ: -0.62,
      viewScale: 0.9,
      viewPos: { x: 0, y: 0, z: 0.08 },
      remoteScale: 0.9,
      remotePos: { x: 0, y: 1.04, z: 0.30 },
    },
    {
      id: 'pistol',
      label: 'PX-7',
      role: '能量手枪',
      mag: 12,
      damage: 28,
      fireInterval: 0.28,
      cooldownMs: 240,
      reloadMs: 1150,
      spread: 0.009,
      recoil: 0.042,
      kick: 0.045,
      muzzleZ: -0.32,
      viewScale: 1.34,
      viewPos: { x: 0.03, y: -0.01, z: 0.02 },
      remoteScale: 1.15,
      remotePos: { x: 0.05, y: 1.06, z: 0.18 },
    },
  ];

  const byId = Object.fromEntries(list.map((w) => [w.id, w]));
  return {
    defaultId: 'rifle',
    list,
    byId,
    ids: list.map((w) => w.id),
  };
});
