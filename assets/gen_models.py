#!/usr/bin/env python3
"""
arena-fps hard-surface GLB asset generator.

The original project used Blender Python, but this machine no longer has a
working Blender install. This generator writes GLB 2.0 directly with only the
Python standard library, so the assets can be regenerated anywhere.

Units are metres and match the runtime:
  X = right, Y = up, Z = depth. Model fronts face -Z.
  Building modules use bottom-centre origins.
  Weapons use the grip/receiver area as their local origin and point -Z.
"""

from __future__ import annotations

import json
import math
import os
import struct
from typing import Dict, Iterable, List, Sequence, Tuple


OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
os.makedirs(OUT, exist_ok=True)

V3 = Tuple[float, float, float]

ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125


PALETTE = {
    "concrete": (0.58, 0.55, 0.49, 1.0),
    "concrete_dark": (0.36, 0.34, 0.30, 1.0),
    "frame": (0.12, 0.13, 0.14, 1.0),
    "frame2": (0.20, 0.21, 0.22, 1.0),
    "gunmetal": (0.08, 0.09, 0.10, 1.0),
    "gunmetal2": (0.20, 0.22, 0.24, 1.0),
    "rubber": (0.025, 0.028, 0.032, 1.0),
    "olive": (0.31, 0.33, 0.20, 1.0),
    "olive_dark": (0.20, 0.22, 0.14, 1.0),
    "cloth": (0.27, 0.29, 0.17, 1.0),
    "armor": (0.12, 0.13, 0.13, 1.0),
    "armor_edge": (0.24, 0.25, 0.25, 1.0),
    "skin": (0.50, 0.39, 0.28, 1.0),
    "cyan": (0.03, 0.90, 1.00, 1.0),
    "cyan_dim": (0.02, 0.36, 0.42, 1.0),
    "orange": (1.00, 0.48, 0.04, 1.0),
    "glass": (0.45, 0.72, 0.88, 0.38),
    "floor": (0.48, 0.46, 0.40, 1.0),
}


def add(a: V3, b: V3) -> V3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a: V3, b: V3) -> V3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a: V3, s: float) -> V3:
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a: V3, b: V3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: V3, b: V3) -> V3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def length(a: V3) -> float:
    return math.sqrt(max(0.0, dot(a, a)))


def norm(a: V3) -> V3:
    l = length(a)
    if l < 1e-9:
        return (0.0, 1.0, 0.0)
    return (a[0] / l, a[1] / l, a[2] / l)


def basis_from_axis(axis: V3) -> Tuple[V3, V3, V3]:
    w = norm(axis)
    helper = (0.0, 1.0, 0.0) if abs(w[1]) < 0.92 else (1.0, 0.0, 0.0)
    u = norm(cross(helper, w))
    v = norm(cross(w, u))
    return u, v, w


class GLB:
    def __init__(self, name: str):
        self.name = name
        self.bin = bytearray()
        self.buffer_views: List[dict] = []
        self.accessors: List[dict] = []
        self.meshes: List[dict] = []
        self.nodes: List[dict] = []
        self.materials: List[dict] = []
        self.material_index: Dict[str, int] = {}
        self.position_scale: V3 = (1.0, 1.0, 1.0)

    def material(
        self,
        name: str,
        color: Sequence[float],
        *,
        roughness: float = 0.82,
        metallic: float = 0.0,
        emissive: Sequence[float] | None = None,
    ) -> int:
        if name in self.material_index:
            return self.material_index[name]

        mat = {
            "name": name,
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [round(float(x), 5) for x in color],
                "metallicFactor": metallic,
                "roughnessFactor": roughness,
            },
        }
        if color[3] < 1.0:
            mat["alphaMode"] = "BLEND"
            mat["alphaCutoff"] = 0.05
        if emissive:
            mat["emissiveFactor"] = [round(float(x), 5) for x in emissive[:3]]

        idx = len(self.materials)
        self.materials.append(mat)
        self.material_index[name] = idx
        return idx

    def _append(self, payload: bytes, *, target: int) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        offset = len(self.bin)
        self.bin.extend(payload)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload), "target": target}
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def _accessor(
        self,
        payload: bytes,
        *,
        target: int,
        component_type: int,
        gltf_type: str,
        count: int,
        minmax_source: Sequence[float] | None = None,
    ) -> int:
        view = self._append(payload, target=target)
        acc = {
            "bufferView": view,
            "componentType": component_type,
            "count": count,
            "type": gltf_type,
        }
        if minmax_source is not None and gltf_type == "VEC3":
            pts = list(zip(*(iter(minmax_source),) * 3))
            acc["min"] = [round(min(p[i] for p in pts), 6) for i in range(3)]
            acc["max"] = [round(max(p[i] for p in pts), 6) for i in range(3)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_mesh(
        self,
        name: str,
        positions: Sequence[float],
        normals: Sequence[float],
        indices: Sequence[int],
        material: int,
    ) -> None:
        if not positions or not indices:
            return

        if self.position_scale != (1.0, 1.0, 1.0):
            sx, sy, sz = self.position_scale
            positions = [
                value * (sx if i % 3 == 0 else sy if i % 3 == 1 else sz)
                for i, value in enumerate(positions)
            ]

        pos_payload = struct.pack("<" + "f" * len(positions), *positions)
        nor_payload = struct.pack("<" + "f" * len(normals), *normals)
        max_index = max(indices)
        if max_index <= 65535:
            idx_payload = struct.pack("<" + "H" * len(indices), *indices)
            idx_component = UNSIGNED_SHORT
        else:
            idx_payload = struct.pack("<" + "I" * len(indices), *indices)
            idx_component = UNSIGNED_INT

        pos_acc = self._accessor(
            pos_payload,
            target=ARRAY_BUFFER,
            component_type=FLOAT,
            gltf_type="VEC3",
            count=len(positions) // 3,
            minmax_source=positions,
        )
        nor_acc = self._accessor(
            nor_payload,
            target=ARRAY_BUFFER,
            component_type=FLOAT,
            gltf_type="VEC3",
            count=len(normals) // 3,
        )
        idx_acc = self._accessor(
            idx_payload,
            target=ELEMENT_ARRAY_BUFFER,
            component_type=idx_component,
            gltf_type="SCALAR",
            count=len(indices),
        )

        mesh_idx = len(self.meshes)
        self.meshes.append(
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": {"POSITION": pos_acc, "NORMAL": nor_acc},
                        "indices": idx_acc,
                        "material": material,
                    }
                ],
            }
        )
        self.nodes.append({"name": name, "mesh": mesh_idx})

    def write(self, path: str) -> None:
        while len(self.bin) % 4:
            self.bin.append(0)

        used_materials = sorted(
            {
                prim["material"]
                for mesh in self.meshes
                for prim in mesh.get("primitives", [])
                if "material" in prim
            }
        )
        material_remap = {old: new for new, old in enumerate(used_materials)}
        materials = [self.materials[i] for i in used_materials]
        for mesh in self.meshes:
            for prim in mesh.get("primitives", []):
                if "material" in prim:
                    prim["material"] = material_remap[prim["material"]]

        gltf = {
            "asset": {"version": "2.0", "generator": "arena-fps direct-glb generator"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.nodes)))}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": materials,
            "buffers": [{"byteLength": len(self.bin)}],
            "bufferViews": self.buffer_views,
            "accessors": self.accessors,
        }

        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        while len(json_bytes) % 4:
            json_bytes += b" "

        total_len = 12 + 8 + len(json_bytes) + 8 + len(self.bin)
        with open(path, "wb") as f:
            f.write(struct.pack("<4sII", b"glTF", 2, total_len))
            f.write(struct.pack("<I4s", len(json_bytes), b"JSON"))
            f.write(json_bytes)
            f.write(struct.pack("<I4s", len(self.bin), b"BIN\x00"))
            f.write(self.bin)


def add_common_materials(g: GLB) -> Dict[str, int]:
    return {
        "concrete": g.material("concrete_warm_panel", PALETTE["concrete"], roughness=0.94),
        "concrete_dark": g.material("concrete_dark_panel", PALETTE["concrete_dark"], roughness=0.92),
        "frame": g.material("dark_anodized_frame", PALETTE["frame"], roughness=0.63, metallic=0.45),
        "frame2": g.material("worn_graphite_frame", PALETTE["frame2"], roughness=0.66, metallic=0.35),
        "gunmetal": g.material("gunmetal_black", PALETTE["gunmetal"], roughness=0.48, metallic=0.75),
        "gunmetal2": g.material("gunmetal_edge", PALETTE["gunmetal2"], roughness=0.52, metallic=0.62),
        "rubber": g.material("matte_black_rubber", PALETTE["rubber"], roughness=0.95),
        "olive": g.material("olive_armor_panel", PALETTE["olive"], roughness=0.72, metallic=0.08),
        "olive_dark": g.material("olive_dark_panel", PALETTE["olive_dark"], roughness=0.78, metallic=0.04),
        "cloth": g.material("cloth_olive_uniform", PALETTE["cloth"], roughness=0.9),
        "armor": g.material("armor_dark_plate", PALETTE["armor"], roughness=0.66, metallic=0.22),
        "armor_edge": g.material("armor_edge_plate", PALETTE["armor_edge"], roughness=0.58, metallic=0.35),
        "skin": g.material("skin_visible_neck", PALETTE["skin"], roughness=0.82),
        "cyan": g.material("accent_cyan_energy", PALETTE["cyan"], roughness=0.22, metallic=0.2, emissive=PALETTE["cyan"]),
        "cyan_dim": g.material("accent_cyan_dim_glass", PALETTE["cyan_dim"], roughness=0.18, metallic=0.0, emissive=(0.0, 0.2, 0.24)),
        "orange": g.material("orange_warning_chip", PALETTE["orange"], roughness=0.42, metallic=0.15, emissive=(0.55, 0.22, 0.0)),
        "glass": g.material("blue_grey_glass", PALETTE["glass"], roughness=0.18, metallic=0.0, emissive=(0.05, 0.12, 0.16)),
        "floor": g.material("floor_concrete_tile", PALETTE["floor"], roughness=0.95),
    }


def push_quad(
    positions: List[float],
    normals: List[float],
    indices: List[int],
    corners: Sequence[V3],
    normal: V3,
) -> None:
    a, b, c, d = corners
    n = norm(normal)
    if dot(cross(sub(b, a), sub(c, a)), n) < 0:
        b, d = d, b
    base = len(positions) // 3
    for p in (a, b, c, d):
        positions.extend(p)
        normals.extend(n)
    indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])


def push_tri(
    positions: List[float],
    normals: List[float],
    indices: List[int],
    corners: Sequence[V3],
    normal: V3,
) -> None:
    a, b, c = corners
    n = norm(normal)
    if dot(cross(sub(b, a), sub(c, a)), n) < 0:
        b, c = c, b
    base = len(positions) // 3
    for p in (a, b, c):
        positions.extend(p)
        normals.extend(n)
    indices.extend([base, base + 1, base + 2])


def add_box(g: GLB, name: str, center: V3, size: V3, material: int) -> None:
    cx, cy, cz = center
    sx, sy, sz = size
    x0, x1 = cx - sx / 2, cx + sx / 2
    y0, y1 = cy - sy / 2, cy + sy / 2
    z0, z1 = cz - sz / 2, cz + sz / 2
    p: List[float] = []
    n: List[float] = []
    idx: List[int] = []

    push_quad(p, n, idx, [(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)], (-1, 0, 0))
    push_quad(p, n, idx, [(x1, y0, z1), (x1, y1, z1), (x1, y1, z0), (x1, y0, z0)], (1, 0, 0))
    push_quad(p, n, idx, [(x0, y0, z1), (x1, y0, z1), (x1, y0, z0), (x0, y0, z0)], (0, -1, 0))
    push_quad(p, n, idx, [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], (0, 1, 0))
    push_quad(p, n, idx, [(x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z0)], (0, 0, -1))
    push_quad(p, n, idx, [(x0, y0, z1), (x0, y1, z1), (x1, y1, z1), (x1, y0, z1)], (0, 0, 1))
    g.add_mesh(name, p, n, idx, material)


def add_cylinder_between(
    g: GLB,
    name: str,
    a: V3,
    b: V3,
    radius: float,
    segments: int,
    material: int,
) -> None:
    axis = sub(b, a)
    u, v, w = basis_from_axis(axis)
    p: List[float] = []
    n: List[float] = []
    idx: List[int] = []
    seg = max(5, segments)
    ring_a: List[V3] = []
    ring_b: List[V3] = []
    radial: List[V3] = []

    for i in range(seg):
        t = math.tau * i / seg
        r = norm(add(mul(u, math.cos(t)), mul(v, math.sin(t))))
        radial.append(r)
        ring_a.append(add(a, mul(r, radius)))
        ring_b.append(add(b, mul(r, radius)))

    for i in range(seg):
        j = (i + 1) % seg
        face_n = norm(add(radial[i], radial[j]))
        push_quad(p, n, idx, [ring_a[i], ring_a[j], ring_b[j], ring_b[i]], face_n)
        push_tri(p, n, idx, [a, ring_a[i], ring_a[j]], mul(w, -1))
        push_tri(p, n, idx, [b, ring_b[j], ring_b[i]], w)

    g.add_mesh(name, p, n, idx, material)


def add_cylinder_axis(
    g: GLB,
    name: str,
    center: V3,
    radius: float,
    depth: float,
    axis: str,
    segments: int,
    material: int,
) -> None:
    vec = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}[axis]
    half = mul(vec, depth / 2)
    add_cylinder_between(g, name, sub(center, half), add(center, half), radius, segments, material)


def add_sphere(
    g: GLB,
    name: str,
    center: V3,
    radius: V3,
    segments: int,
    rings: int,
    material: int,
) -> None:
    p: List[float] = []
    n: List[float] = []
    idx: List[int] = []
    seg = max(6, segments)
    rng = max(3, rings)

    def point(lat_i: int, seg_i: int) -> Tuple[V3, V3]:
        theta = math.pi * lat_i / rng
        phi = math.tau * seg_i / seg
        unit = (math.sin(theta) * math.cos(phi), math.cos(theta), math.sin(theta) * math.sin(phi))
        pos = (center[0] + unit[0] * radius[0], center[1] + unit[1] * radius[1], center[2] + unit[2] * radius[2])
        return pos, norm(unit)

    for lat in range(rng):
        for s in range(seg):
            a, na = point(lat, s)
            b, nb = point(lat, s + 1)
            c, nc = point(lat + 1, s + 1)
            d, nd = point(lat + 1, s)
            base = len(p) // 3
            for pos, normal in ((a, na), (b, nb), (c, nc), (d, nd)):
                p.extend(pos)
                n.extend(normal)
            idx.extend([base, base + 1, base + 2, base, base + 2, base + 3])

    g.add_mesh(name, p, n, idx, material)


def add_chamfered_plate(
    g: GLB,
    name: str,
    center: V3,
    u_axis: str,
    v_axis: str,
    n_axis: str,
    width: float,
    height: float,
    depth: float,
    chamfer: float,
    material: int,
) -> None:
    axes = {
        "x": (1.0, 0.0, 0.0),
        "y": (0.0, 1.0, 0.0),
        "z": (0.0, 0.0, 1.0),
    }
    u = axes[u_axis]
    v = axes[v_axis]
    nn = axes[n_axis]
    c = min(chamfer, width * 0.24, height * 0.24)
    shape = [
        (-width / 2 + c, -height / 2),
        (width / 2 - c, -height / 2),
        (width / 2, -height / 2 + c),
        (width / 2, height / 2 - c),
        (width / 2 - c, height / 2),
        (-width / 2 + c, height / 2),
        (-width / 2, height / 2 - c),
        (-width / 2, -height / 2 + c),
    ]

    def orient(du: float, dv: float, dn: float) -> V3:
        return add(add(add(center, mul(u, du)), mul(v, dv)), mul(nn, dn))

    front = [orient(du, dv, -depth / 2) for du, dv in shape]
    back = [orient(du, dv, depth / 2) for du, dv in shape]
    p: List[float] = []
    n: List[float] = []
    idx: List[int] = []

    for i in range(1, len(shape) - 1):
        push_tri(p, n, idx, [front[0], front[i], front[i + 1]], mul(nn, -1))
        push_tri(p, n, idx, [back[0], back[i + 1], back[i]], nn)

    for i in range(len(shape)):
        j = (i + 1) % len(shape)
        edge = sub(front[j], front[i])
        face_n = norm(cross(edge, nn))
        push_quad(p, n, idx, [front[i], front[j], back[j], back[i]], face_n)

    g.add_mesh(name, p, n, idx, material)


def add_bolt_pair(g: GLB, base_name: str, x: float, y: float, z: float, mat: int) -> None:
    add_cylinder_axis(g, base_name + "_f", (x, y, z), 0.012, 0.012, "z", 8, mat)
    add_cylinder_axis(g, base_name + "_b", (x, y, -z), 0.012, 0.012, "z", 8, mat)


def make_asset(name: str) -> Tuple[GLB, Dict[str, int]]:
    g = GLB(name)
    return g, add_common_materials(g)


def export(name: str, g: GLB) -> None:
    path = os.path.join(OUT, name + ".glb")
    g.write(path)
    print(f"  wrote {name}.glb -> {path}")


def add_wall_surface_details(g: GLB, m: Dict[str, int], prefix: str, width: float = 1.0) -> None:
    for face, z in (("front", -0.096), ("back", 0.096)):
        add_chamfered_plate(g, f"{prefix}_{face}_upper_panel", (0, 2.18, z), "x", "y", "z", width * 0.74, 0.60, 0.010, 0.045, m["concrete_dark"])
        add_chamfered_plate(g, f"{prefix}_{face}_lower_panel", (0, 1.05, z), "x", "y", "z", width * 0.70, 0.72, 0.010, 0.045, m["concrete"])
        add_box(g, f"{prefix}_{face}_olive_band", (0, 1.78, z), (width * 0.86, 0.14, 0.010), m["olive"])
        add_box(g, f"{prefix}_{face}_orange_chip", (width * 0.33, 2.68, z), (0.045, 0.065, 0.012), m["orange"])
        for bx in (-width * 0.36, width * 0.36):
            for by in (0.78, 2.48):
                add_cylinder_axis(g, f"{prefix}_{face}_bolt_{bx:.2f}_{by:.2f}", (bx, by, z), 0.012, 0.012, "z", 8, m["frame2"])


def gen_wall() -> None:
    g, m = make_asset("wall")
    add_box(g, "wall_core_concrete", (0, 1.50, 0), (0.92, 2.82, 0.16), m["concrete"])
    add_box(g, "wall_top_dark_cap", (0, 2.94, 0), (1.00, 0.12, 0.20), m["frame"])
    add_box(g, "wall_bottom_dark_cap", (0, 0.06, 0), (1.00, 0.12, 0.20), m["frame"])
    add_box(g, "wall_left_vertical_cap", (-0.46, 1.50, 0), (0.08, 2.76, 0.20), m["frame2"])
    add_box(g, "wall_right_vertical_cap", (0.46, 1.50, 0), (0.08, 2.76, 0.20), m["frame2"])
    add_wall_surface_details(g, m, "wall")
    export("wall", g)


def gen_wall_window() -> None:
    g, m = make_asset("wall_window")
    add_box(g, "window_wall_left_slab", (-0.43, 1.50, 0), (0.14, 2.82, 0.16), m["concrete"])
    add_box(g, "window_wall_right_slab", (0.43, 1.50, 0), (0.14, 2.82, 0.16), m["concrete"])
    add_box(g, "window_wall_lower_slab", (0, 0.55, 0), (0.88, 1.10, 0.16), m["concrete"])
    add_box(g, "window_wall_upper_slab", (0, 2.68, 0), (0.88, 0.52, 0.16), m["concrete"])
    add_box(g, "window_wall_top_cap", (0, 2.94, 0), (1.00, 0.12, 0.20), m["frame"])
    add_box(g, "window_wall_bottom_cap", (0, 0.06, 0), (1.00, 0.12, 0.20), m["frame"])
    for face, z in (("front", -0.095), ("back", 0.095)):
        add_box(g, f"window_{face}_frame_top", (0, 2.18, z), (0.68, 0.08, 0.012), m["frame"])
        add_box(g, f"window_{face}_frame_bottom", (0, 1.24, z), (0.68, 0.08, 0.012), m["frame"])
        add_box(g, f"window_{face}_frame_left", (-0.36, 1.71, z), (0.08, 0.98, 0.012), m["frame"])
        add_box(g, f"window_{face}_frame_right", (0.36, 1.71, z), (0.08, 0.98, 0.012), m["frame"])
        add_box(g, f"window_{face}_orange_chip", (0.39, 2.68, z), (0.04, 0.06, 0.012), m["orange"])
    add_box(g, "window_blue_glass", (0, 1.71, 0), (0.58, 0.80, 0.025), m["glass"])
    export("wall_window", g)


def gen_wall_door() -> None:
    g, m = make_asset("wall_door")
    add_box(g, "door_wall_left_jamb", (-0.46, 1.50, 0), (0.08, 2.82, 0.16), m["concrete"])
    add_box(g, "door_wall_right_jamb", (0.42, 1.50, 0), (0.16, 2.82, 0.16), m["concrete"])
    add_box(g, "door_wall_header", (-0.06, 2.64, 0), (0.84, 0.60, 0.16), m["concrete"])
    add_box(g, "door_wall_top_cap", (0, 2.94, 0), (1.00, 0.12, 0.20), m["frame"])
    add_box(g, "door_wall_bottom_right_cap", (0.42, 0.06, 0), (0.16, 0.12, 0.20), m["frame"])
    for face, z in (("front", -0.095), ("back", 0.095)):
        add_box(g, f"door_{face}_frame_top", (-0.10, 2.22, z), (0.80, 0.08, 0.012), m["frame"])
        add_box(g, f"door_{face}_frame_left", (-0.47, 1.10, z), (0.06, 2.20, 0.012), m["frame"])
        add_box(g, f"door_{face}_frame_right", (0.30, 1.10, z), (0.07, 2.20, 0.012), m["frame"])
        add_box(g, f"door_{face}_olive_header", (-0.06, 2.52, z), (0.62, 0.12, 0.012), m["olive"])
        add_box(g, f"door_{face}_lamp", (0.33, 2.72, z), (0.045, 0.055, 0.012), m["orange"])
    export("wall_door", g)


def gen_stairs() -> None:
    g, m = make_asset("stairs")
    steps = 5
    for i in range(steps):
        h = (i + 1) / steps
        d = 1.0 / steps
        z = -0.5 + d * i + d / 2
        add_box(g, f"stair_concrete_step_{i}", (0, h / 2, z), (0.72, h, d), m["concrete"])
        add_box(g, f"stair_dark_nosing_{i}", (0, h - 0.012, z - d / 2 + 0.012), (0.78, 0.024, 0.024), m["frame"])
    for x in (-0.43, 0.43):
        add_box(g, f"stair_side_rail_{x}", (x, 0.45, 0), (0.12, 0.86, 0.98), m["olive_dark"])
        add_box(g, f"stair_side_top_{x}", (x, 0.89, 0), (0.12, 0.08, 0.98), m["frame"])
        add_box(g, f"stair_orange_chip_{x}", (x, 0.18, -0.42), (0.122, 0.05, 0.05), m["orange"])
    export("stairs", g)


def gen_cover() -> None:
    g, m = make_asset("cover")
    add_box(g, "cover_long_base", (0, 0.08, -0.28), (1.40, 0.16, 0.42), m["concrete_dark"])
    add_box(g, "cover_long_body", (0, 0.47, -0.28), (1.18, 0.66, 0.24), m["concrete"])
    add_box(g, "cover_long_top_cap", (0, 0.84, -0.28), (1.28, 0.10, 0.26), m["frame2"])
    add_box(g, "cover_long_front_foot", (0, 0.22, -0.46), (1.32, 0.24, 0.08), m["concrete"])
    add_box(g, "cover_short_base", (-0.56, 0.08, 0.12), (0.28, 0.16, 0.76), m["concrete_dark"])
    add_box(g, "cover_short_body", (-0.56, 0.47, 0.12), (0.20, 0.66, 0.62), m["concrete"])
    add_box(g, "cover_short_top_cap", (-0.56, 0.84, 0.12), (0.24, 0.10, 0.70), m["frame2"])
    for z in (-0.475, -0.06):
        add_box(g, f"cover_orange_stripe_{z}", (0.54, 0.52, z), (0.045, 0.36, 0.05), m["orange"])
    add_chamfered_plate(g, "cover_front_panel", (0, 0.48, -0.406), "x", "y", "z", 0.82, 0.38, 0.012, 0.045, m["concrete_dark"])
    export("cover", g)


def gen_crate() -> None:
    g, m = make_asset("crate")
    add_box(g, "crate_dark_core", (0, 0.40, 0), (0.66, 0.66, 0.66), m["frame"])
    add_box(g, "crate_inner_panel_front", (0, 0.40, -0.34), (0.48, 0.38, 0.025), m["gunmetal2"])
    add_box(g, "crate_inner_panel_back", (0, 0.40, 0.34), (0.48, 0.38, 0.025), m["gunmetal2"])
    add_box(g, "crate_inner_panel_left", (-0.34, 0.40, 0), (0.025, 0.38, 0.48), m["gunmetal2"])
    add_box(g, "crate_inner_panel_right", (0.34, 0.40, 0), (0.025, 0.38, 0.48), m["gunmetal2"])
    for x in (-0.34, 0.34):
        for z in (-0.34, 0.34):
            add_box(g, f"crate_corner_post_{x}_{z}", (x, 0.40, z), (0.12, 0.78, 0.12), m["frame2"])
            add_box(g, f"crate_corner_orange_{x}_{z}", (x, 0.12, z), (0.052, 0.07, 0.055), m["orange"])
    add_box(g, "crate_top_lid", (0, 0.77, 0), (0.74, 0.06, 0.74), m["gunmetal2"])
    add_box(g, "crate_bottom_plinth", (0, 0.03, 0), (0.74, 0.06, 0.74), m["rubber"])
    add_chamfered_plate(g, "crate_top_center_plate", (0, 0.785, 0), "x", "z", "y", 0.48, 0.48, 0.02, 0.06, m["frame"])
    add_box(g, "crate_cyan_lock", (0, 0.47, -0.365), (0.16, 0.045, 0.025), m["cyan"])
    export("crate", g)


def gen_floor_tile() -> None:
    g, m = make_asset("floor_tile")
    add_box(g, "floor_tile_base", (0, 0.03, 0), (1.00, 0.06, 1.00), m["floor"])
    add_box(g, "floor_tile_front_rail", (0, 0.075, -0.47), (1.00, 0.03, 0.06), m["frame"])
    add_box(g, "floor_tile_back_rail", (0, 0.075, 0.47), (1.00, 0.03, 0.06), m["frame"])
    add_box(g, "floor_tile_left_rail", (-0.47, 0.075, 0), (0.06, 0.03, 1.00), m["frame"])
    add_box(g, "floor_tile_right_rail", (0.47, 0.075, 0), (0.06, 0.03, 1.00), m["frame"])
    for x in (-0.24, 0.24):
        for z in (-0.24, 0.24):
            add_chamfered_plate(g, f"floor_panel_{x}_{z}", (x, 0.102, z), "x", "z", "y", 0.40, 0.40, 0.018, 0.035, m["concrete"])
    for x in (-0.43, 0.43):
        add_box(g, f"floor_orange_chip_{x}", (x, 0.112, -0.43), (0.05, 0.018, 0.04), m["orange"])
    export("floor_tile", g)


def gen_pistol() -> None:
    g, m = make_asset("pistol")
    add_box(g, "pistol_main_slide", (0, 0.030, -0.040), (0.115, 0.115, 0.280), m["gunmetal"])
    add_box(g, "pistol_top_rail", (0, 0.105, -0.035), (0.095, 0.035, 0.240), m["gunmetal2"])
    add_box(g, "pistol_front_muzzle_block", (0, 0.030, -0.185), (0.130, 0.130, 0.060), m["frame2"])
    add_cylinder_axis(g, "pistol_cyan_muzzle", (0, 0.030, -0.220), 0.032, 0.020, "z", 8, m["cyan"])
    add_box(g, "pistol_side_energy_left", (-0.061, 0.042, -0.050), (0.012, 0.050, 0.145), m["cyan"])
    add_box(g, "pistol_side_energy_right", (0.061, 0.042, -0.050), (0.012, 0.050, 0.145), m["cyan"])
    add_box(g, "pistol_olive_grip", (0, -0.092, 0.095), (0.090, 0.215, 0.095), m["olive"])
    add_box(g, "pistol_grip_backstrap", (0, -0.090, 0.145), (0.115, 0.220, 0.032), m["rubber"])
    add_box(g, "pistol_trigger_guard_top", (0, -0.042, 0.002), (0.085, 0.025, 0.075), m["gunmetal2"])
    add_box(g, "pistol_trigger_guard_bottom", (0, -0.088, 0.002), (0.085, 0.025, 0.075), m["gunmetal2"])
    add_box(g, "pistol_orange_status", (0.000, 0.108, 0.040), (0.055, 0.018, 0.035), m["orange"])
    export("pistol", g)


def gen_rifle() -> None:
    g, m = make_asset("rifle")
    add_box(g, "rifle_receiver_core", (0, 0.020, -0.110), (0.135, 0.145, 0.360), m["gunmetal"])
    add_box(g, "rifle_receiver_top_rail", (0, 0.115, -0.115), (0.110, 0.035, 0.385), m["gunmetal2"])
    add_box(g, "rifle_lower_frame", (0, -0.060, -0.110), (0.115, 0.055, 0.325), m["frame2"])
    add_box(g, "rifle_olive_side_left", (-0.076, 0.025, -0.150), (0.020, 0.095, 0.210), m["olive"])
    add_box(g, "rifle_olive_side_right", (0.076, 0.025, -0.150), (0.020, 0.095, 0.210), m["olive"])
    add_box(g, "rifle_cyan_energy_core", (0, 0.044, -0.165), (0.082, 0.060, 0.245), m["cyan"])
    add_box(g, "rifle_cyan_core_glass_left", (-0.083, 0.043, -0.165), (0.012, 0.045, 0.185), m["cyan_dim"])
    add_box(g, "rifle_cyan_core_glass_right", (0.083, 0.043, -0.165), (0.012, 0.045, 0.185), m["cyan_dim"])
    add_box(g, "rifle_front_shroud", (0, 0.030, -0.390), (0.190, 0.175, 0.160), m["frame2"])
    add_cylinder_axis(g, "rifle_outer_barrel", (0, 0.030, -0.540), 0.030, 0.235, "z", 10, m["gunmetal2"])
    add_cylinder_axis(g, "rifle_cyan_muzzle_core", (0, 0.030, -0.655), 0.023, 0.025, "z", 10, m["cyan"])
    add_box(g, "rifle_rear_stock_core", (0, 0.018, 0.245), (0.125, 0.125, 0.220), m["gunmetal2"])
    add_box(g, "rifle_rear_olive_pad", (0, 0.030, 0.375), (0.155, 0.140, 0.065), m["olive"])
    add_box(g, "rifle_pistol_grip", (0, -0.145, 0.085), (0.080, 0.205, 0.080), m["olive_dark"])
    add_box(g, "rifle_trigger_guard_front", (0, -0.085, -0.005), (0.075, 0.030, 0.038), m["frame2"])
    add_box(g, "rifle_trigger_guard_bottom", (0, -0.135, 0.030), (0.075, 0.030, 0.100), m["frame2"])
    add_box(g, "rifle_foregrip", (0, -0.135, -0.260), (0.075, 0.145, 0.060), m["rubber"])
    add_box(g, "rifle_orange_status_top", (0, 0.142, 0.025), (0.060, 0.018, 0.040), m["orange"])
    add_box(g, "rifle_orange_status_side_l", (-0.086, 0.035, -0.315), (0.012, 0.045, 0.035), m["orange"])
    add_box(g, "rifle_orange_status_side_r", (0.086, 0.035, -0.315), (0.012, 0.045, 0.035), m["orange"])
    export("rifle", g)


def gen_soldier() -> None:
    g, m = make_asset("soldier")
    g.position_scale = (0.92, 0.92, 0.92)

    # Boots and legs. Origin is at the feet.
    for side, x in (("l", -0.14), ("r", 0.14)):
        add_box(g, f"soldier_{side}_boot", (x, 0.055, -0.025), (0.18, 0.11, 0.32), m["armor"])
        add_box(g, f"soldier_{side}_toe_cap", (x, 0.078, -0.190), (0.17, 0.065, 0.085), m["armor_edge"])
        add_cylinder_between(g, f"soldier_{side}_shin", (x, 0.14, 0.015), (x, 0.57, 0.015), 0.070, 7, m["armor"])
        add_box(g, f"soldier_{side}_knee_pad", (x, 0.64, -0.095), (0.18, 0.14, 0.075), m["armor_edge"])
        add_cylinder_between(g, f"soldier_{side}_thigh", (x, 0.72, 0.020), (x, 1.02, 0.020), 0.095, 7, m["cloth"])
        add_box(g, f"soldier_{side}_thigh_strap", (x, 0.88, -0.090), (0.20, 0.050, 0.055), m["armor"])
        add_box(g, f"soldier_{side}_side_pouch", (x * 1.55, 0.86, 0.025), (0.075, 0.16, 0.115), m["armor"])

    add_box(g, "soldier_pelvis_cloth", (0, 0.91, 0.015), (0.42, 0.22, 0.24), m["cloth"])
    add_box(g, "soldier_belt_dark", (0, 1.02, -0.010), (0.50, 0.070, 0.255), m["armor"])
    for x in (-0.18, 0.0, 0.18):
        add_box(g, f"soldier_front_belt_pouch_{x}", (x, 0.98, -0.155), (0.10, 0.14, 0.055), m["armor_edge"])
    add_box(g, "soldier_belt_orange_chip", (0.26, 1.01, -0.06), (0.035, 0.055, 0.035), m["orange"])

    add_box(g, "soldier_torso_cloth", (0, 1.28, 0.030), (0.48, 0.48, 0.26), m["cloth"])
    add_box(g, "soldier_chest_plate", (0, 1.31, -0.135), (0.44, 0.38, 0.060), m["armor_edge"])
    add_chamfered_plate(g, "soldier_chest_inner_panel", (0, 1.33, -0.170), "x", "y", "z", 0.32, 0.24, 0.024, 0.030, m["armor"])
    add_box(g, "soldier_backpack", (0, 1.28, 0.185), (0.42, 0.48, 0.090), m["armor"])
    add_chamfered_plate(g, "soldier_backpack_plate", (0, 1.31, 0.236), "x", "y", "z", 0.30, 0.32, 0.020, 0.030, m["armor_edge"])
    for x in (-0.18, 0, 0.18):
        add_box(g, f"soldier_chest_mag_{x}", (x, 1.10, -0.185), (0.10, 0.18, 0.050), m["armor_edge"])
    for x in (-0.19, 0.19):
        add_box(g, f"soldier_shoulder_strap_{x}", (x, 1.48, -0.030), (0.08, 0.34, 0.075), m["armor"])
        add_box(g, f"soldier_shoulder_pad_{x}", (x * 1.35, 1.45, -0.010), (0.15, 0.13, 0.18), m["armor_edge"])

    # Arms are posed forward for the remote-player weapon.
    add_cylinder_between(g, "soldier_l_upper_arm", (-0.32, 1.42, -0.01), (-0.24, 1.16, -0.11), 0.062, 7, m["cloth"])
    add_cylinder_between(g, "soldier_r_upper_arm", (0.32, 1.42, -0.01), (0.24, 1.18, -0.08), 0.062, 7, m["cloth"])
    add_cylinder_between(g, "soldier_l_forearm", (-0.24, 1.16, -0.11), (-0.08, 1.05, -0.30), 0.055, 7, m["armor"])
    add_cylinder_between(g, "soldier_r_forearm", (0.24, 1.18, -0.08), (0.10, 1.07, -0.26), 0.055, 7, m["armor"])
    add_box(g, "soldier_l_glove", (-0.07, 1.03, -0.335), (0.09, 0.08, 0.08), m["armor"])
    add_box(g, "soldier_r_glove", (0.11, 1.05, -0.295), (0.09, 0.08, 0.08), m["armor"])

    add_cylinder_between(g, "soldier_neck", (0, 1.50, 0.0), (0, 1.61, 0.0), 0.060, 7, m["skin"])
    add_sphere(g, "soldier_head_under_helmet", (0, 1.67, -0.005), (0.145, 0.170, 0.130), 8, 5, m["armor"])
    add_sphere(g, "soldier_helmet_shell", (0, 1.74, 0.005), (0.205, 0.165, 0.180), 9, 4, m["olive_dark"])
    add_box(g, "soldier_helmet_front_brow", (0, 1.705, -0.163), (0.34, 0.055, 0.050), m["armor"])
    add_box(g, "soldier_helmet_top_mount", (0, 1.875, -0.028), (0.105, 0.045, 0.105), m["armor_edge"])
    add_box(g, "soldier_visor_glow", (0, 1.675, -0.178), (0.270, 0.080, 0.030), m["cyan_dim"])
    add_box(g, "soldier_face_mask", (0, 1.590, -0.165), (0.215, 0.105, 0.045), m["armor_edge"])
    for x in (-0.205, 0.205):
        add_box(g, f"soldier_helmet_ear_{x}", (x, 1.675, -0.010), (0.060, 0.135, 0.105), m["armor"])
    add_box(g, "soldier_orange_shoulder_chip", (0.30, 1.43, -0.105), (0.032, 0.055, 0.035), m["orange"])

    export("soldier", g)


GENERATORS = [
    ("soldier", gen_soldier),
    ("rifle", gen_rifle),
    ("pistol", gen_pistol),
    ("wall", gen_wall),
    ("wall_window", gen_wall_window),
    ("wall_door", gen_wall_door),
    ("stairs", gen_stairs),
    ("cover", gen_cover),
    ("crate", gen_crate),
    ("floor_tile", gen_floor_tile),
]


if __name__ == "__main__":
    print("Generating arena-fps GLB assets into", OUT)
    for label, fn in GENERATORS:
        print(f"\n-- {label} --")
        fn()
    print("\nAll assets written.")
