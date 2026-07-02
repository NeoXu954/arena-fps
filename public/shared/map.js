/*
 * 共享地图数据 —— 服务端（碰撞/命中校验/出生点）与客户端（渲染）共用同一份。
 * 对称竞技场：现代军事训练场风格。坐标系 X/Z 为地面，Y 为高度。
 * 所有掩体用 AABB（轴对齐包围盒）表示，便于服务端做射线命中与移动碰撞。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ARENA_MAP = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 竞技场半边长（X、Z 方向各 ±HALF）
  const HALF = 24;
  const WALL_H = 6;       // 外墙高度
  const WALL_T = 1;       // 墙厚

  // 工具：以中心点 + 尺寸生成一个 box（min/max 由渲染端计算）
  function box(cx, cy, cz, sx, sy, sz, type) {
    return { cx, cy, cz, sx, sy, sz, type: type || 'crate' };
  }

  // 外围墙体（四面）
  const walls = [
    box(0, WALL_H / 2, -HALF, HALF * 2 + WALL_T, WALL_H, WALL_T, 'wall'), // 北
    box(0, WALL_H / 2, HALF, HALF * 2 + WALL_T, WALL_H, WALL_T, 'wall'),  // 南
    box(-HALF, WALL_H / 2, 0, WALL_T, WALL_H, HALF * 2 + WALL_T, 'wall'), // 西
    box(HALF, WALL_H / 2, 0, WALL_T, WALL_H, HALF * 2 + WALL_T, 'wall'),  // 东
  ];

  // 掩体：相对中心点对称布置（每个掩体在 +Z 与 -Z 各放一个，保证红蓝对称）
  // 半边定义，再镜像生成
  const halfCovers = [
    // 出生区附近的矮墙掩体
    box(0, 1, 16, 8, 2, 1, 'lowwall'),
    box(-9, 1.25, 14, 3, 2.5, 3, 'container'),
    box(9, 1.25, 14, 3, 2.5, 3, 'container'),
    // 中场两侧集装箱
    box(-13, 1.5, 6, 4, 3, 3, 'container'),
    box(13, 1.5, 6, 4, 3, 3, 'container'),
    // 中场掩体
    box(-6, 1, 7, 2, 2, 2, 'crate'),
    box(6, 1, 7, 2, 2, 2, 'crate'),
    // 坡道（用扁箱体近似，可站上去）
    box(-16, 0.5, 11, 5, 1, 6, 'ramp'),
    box(16, 0.5, 11, 5, 1, 6, 'ramp'),
  ];

  const covers = [];
  halfCovers.forEach(function (c) {
    covers.push(c);
    // 镜像到 -Z 半场
    covers.push(box(c.cx, c.cy, -c.cz, c.sx, c.sy, c.sz, c.type));
  });

  // 中央开阔区的对称十字掩体
  covers.push(box(-4, 1, 0, 2, 2, 4, 'crate'));
  covers.push(box(4, 1, 0, 2, 2, 4, 'crate'));
  covers.push(box(0, 1.25, 0, 5, 2.5, 1, 'lowwall'));

  // 地面（用于射线命中地面）
  const ground = { cx: 0, cy: -0.5, cz: 0, sx: HALF * 2, sy: 1, sz: HALF * 2, type: 'ground' };

  // 出生点：两端，朝向中心
  // 朝向约定：forward = (-sin(yaw), 0, -cos(yaw))。yaw=0 看向 -Z，yaw=π 看向 +Z。
  const spawns = [
    { x: 0, y: 0, z: HALF - 4, yaw: 0 },        // 玩家0（蓝）在 +Z 端，面向中心 -Z
    { x: 0, y: 0, z: -(HALF - 4), yaw: Math.PI }, // 玩家1（红）在 -Z 端，面向中心 +Z
  ];

  // 所有可碰撞实体（墙 + 掩体 + 地面）
  const colliders = walls.concat(covers).concat([ground]);

  return {
    HALF: HALF,
    WALL_H: WALL_H,
    walls: walls,
    covers: covers,
    ground: ground,
    spawns: spawns,
    colliders: colliders,
    // 玩家胶囊参数（服务端碰撞 + 命中体）
    PLAYER_RADIUS: 0.4,
    PLAYER_HEIGHT: 1.7,
    EYE_HEIGHT: 1.5,
  };
});
