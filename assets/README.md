# arena-fps 3D 素材（Low-Poly GLB）

本目录存放游戏的 low-poly / hard-surface 3D 素材，全部为 **GLB 格式**，由
`gen_models.py` 程序化生成，适合 Three.js / WebGL 直接加载。

## 目录

```
assets/
├── gen_models.py     # Blender 生成脚本（一次生成全部 10 个模型）
├── README.md         # 本文件
└── models/           # 生成的 GLB 输出
    ├── soldier.glb       # 士兵角色（约 1.75m 高，第三人称对手）
    ├── rifle.glb         # 突击步枪（第一人称 + 第三人称手持）
    ├── pistol.glb        # 手枪（备用武器）
    ├── wall.glb          # 实心墙体模块（1×3×0.2m）
    ├── wall_window.glb   # 带窗户的墙
    ├── wall_door.glb     # 带门洞的墙
    ├── stairs.glb        # 楼梯（4 级，1×1×1m）
    ├── cover.glb         # L 形掩体 / 路障（0.9m 高）
    ├── crate.glb         # 木箱（0.8m 立方）
    └── floor_tile.glb    # 地板砖（1×1m）
```

## 统一约定

- **单位**：1 Blender 单位 = 1 米 = 1 个 Three.js 单位。
- **朝向**：模型正面朝 **-Z**，头顶朝 **+Y**。
- **原点**：角色 / 武器原点在脚底 / 握持中心；建筑模块原点在底面中心，方便贴地摆放。
- **风格**：统一 low-poly / sci-fi hard-surface，配色见 `gen_models.py` 顶部的 `PALETTE`
  调色板（暖灰混凝土 + 深色装甲框架 + 橄榄绿面板 + 青色能量高亮 + 橙色识别块）。
- **面数**：每个模型控制在数百三角面以内，移动端浏览器也能流畅运行。

## 如何重新生成素材

只需要 **Python 3**，无需 Blender 或第三方依赖。脚本会直接写出 GLB 2.0 二进制文件。

```bash
python3 assets/gen_models.py
```

脚本会清空场景、逐个生成 10 个模型并覆盖写入 `assets/models/*.glb`，控制台打印每个文件的路径。

## 修改素材

所有几何体都在 `gen_models.py` 里用基础图元（box / cylinder / sphere / chamfered plate）拼装。
想调整某个模型：找到对应的 `gen_xxx()` 函数，改尺寸 / 位置 / 材质名，再重新运行脚本即可。
调色统一改顶部 `PALETTE` 字典。

> 这是程序化素材。后续可以用 Blender 手动精修，或替换为美术制作的 GLB，
> 只要保持文件名、比例和朝向约定不变，游戏代码无需改动。
