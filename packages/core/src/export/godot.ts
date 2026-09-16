import type { Project, ProjectAnalysis } from '../model/types.ts';
import { buildLayoutScene } from './layout.ts';
import { hexToRgb, primName, r4, uniqueNamer, type Tuple3 } from './transforms.ts';

export interface GodotSceneOptions {
  hallId?: string;
  /** GLB file names that will be shipped under modelsDir. Items whose glb is not listed get a BoxMesh. */
  availableModels?: string[];
  /** resource directory for models (default res://models/) */
  modelsDir?: string;
  /** add a light + camera so the scene can be opened standalone */
  standalone?: boolean;
}

/** Godot Transform3D literal: basis rows then origin, for a rotation about +Y. */
function transformY(rotationDeg: number, origin: Tuple3): string {
  const t = (rotationDeg * Math.PI) / 180;
  const c = r4(Math.cos(t));
  const s = r4(Math.sin(t));
  // R_y(θ) rows: [c 0 s] [0 1 0] [-s 0 c]
  const rows = [c, 0, s, 0, 1, 0, r4(-s), 0, c];
  return `Transform3D(${rows.join(', ')}, ${origin.join(', ')})`;
}

const color = (hex: string, alpha = 1) => {
  const [r, g, b] = hexToRgb(hex);
  return `Color(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Godot 4 text scene (format=3). Equipment instances reference res://models/<glb> (imported by
 * Godot's glTF importer) or fall back to BoxMesh + StandardMaterial3D per catalog item.
 */
export function exportGodotScene(project: Project, opts: GodotSceneOptions = {}, analysis?: ProjectAnalysis | null): { 'scene.tscn': string } {
  const scene = buildLayoutScene(project, analysis, { hallId: opts.hallId });
  const modelsDir = opts.modelsDir ?? 'res://models/';
  const available = new Set(opts.availableModels ?? []);

  const ext: string[] = [];
  const sub: string[] = [];
  const nodes: string[] = [];
  const extId = new Map<string, string>();
  const boxId = new Map<string, string>();
  let extN = 0;
  let subN = 0;

  const extFor = (glb: string) => {
    let id = extId.get(glb);
    if (!id) {
      id = `${++extN}_${primName(glb.replace(/\.glb$/i, ''))}`;
      extId.set(glb, id);
      ext.push(`[ext_resource type="PackedScene" path="${modelsDir}${glb}" id="${id}"]`);
    }
    return id;
  };
  const boxFor = (key: string, size: Tuple3, hex: string, alpha = 1) => {
    let id = boxId.get(key);
    if (!id) {
      const n = ++subN;
      const mat = `mat_${n}`;
      id = `box_${n}`;
      sub.push(
        `[sub_resource type="StandardMaterial3D" id="${mat}"]\n` +
          `albedo_color = ${color(hex, alpha)}\n` +
          (alpha < 1 ? 'transparency = 1\ncull_mode = 2\n' : '') +
          'roughness = 0.6\n',
      );
      sub.push(`[sub_resource type="BoxMesh" id="${id}"]\nmaterial = SubResource("${mat}")\nsize = Vector3(${size.join(', ')})\n`);
      boxId.set(key, id);
    }
    return id;
  };

  const root = primName(project.name).slice(0, 48) || 'AIDC';
  nodes.push(`[node name="${root}" type="Node3D"]`);
  if (opts.standalone ?? true) {
    nodes.push(`[node name="Sun" type="DirectionalLight3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 0.5, 0.866, 0, -0.866, 0.5, 0, 30, 0)\nshadow_enabled = true`);
    const h0 = scene.halls[0];
    if (h0) {
      const cx = r4(h0.origin.x + h0.width / 2);
      const cz = r4(-(h0.origin.y + h0.depth / 2));
      nodes.push(`[node name="Camera3D" type="Camera3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 0.707, 0.707, 0, -0.707, 0.707, ${cx}, ${r4(Math.max(h0.width, h0.depth) * 0.9)}, ${r4(cz + Math.max(h0.width, h0.depth) * 0.9)})\nfar = 2000.0`);
    }
  }

  const hallNamer = uniqueNamer();
  for (const hall of scene.halls) {
    const hallNode = hallNamer(hall.name);
    nodes.push(`[node name="${hallNode}" type="Node3D" parent="."]\nmetadata/aidc_hall_id = "${hall.id}"`);
    const floorBox = boxFor(`floor-${hall.id}`, hall.floor.yUp.size, '#8e9296');
    nodes.push(`[node name="Floor" type="MeshInstance3D" parent="${hallNode}"]\ntransform = ${transformY(0, hall.floor.yUp.center)}\nmesh = SubResource("${floorBox}")`);
    nodes.push(`[node name="Equipment" type="Node3D" parent="${hallNode}"]`);
    nodes.push(`[node name="Containment" type="Node3D" parent="${hallNode}"]`);
    nodes.push(`[node name="Keepouts" type="Node3D" parent="${hallNode}"]`);

    const podNamer = uniqueNamer();
    const podNodes = new Map<string, string>();
    const eqNamer = uniqueNamer();
    for (const e of scene.equipment.filter((q) => q.hallId === hall.id)) {
      const podKey = e.podId ?? 'room';
      let podNode = podNodes.get(podKey);
      if (!podNode) {
        podNode = podNamer(podKey);
        podNodes.set(podKey, podNode);
        nodes.push(`[node name="${podNode}" type="Node3D" parent="${hallNode}/Equipment"]`);
      }
      const parent = `${hallNode}/Equipment/${podNode}`;
      const cat = scene.catalog[e.catalogId];
      const name = eqNamer(e.tag);
      const meta = `metadata/aidc_id = "${e.id}"\nmetadata/aidc_tag = "${e.tag}"\nmetadata/aidc_catalog_id = "${e.catalogId}"\nmetadata/aidc_category = "${e.category}"`;
      const glb = cat?.glb;
      if (glb && available.has(glb)) {
        nodes.push(`[node name="${name}" parent="${parent}" instance=ExtResource("${extFor(glb)}")]\ntransform = ${transformY(e.transform.yUp.rotationYDeg, e.transform.yUp.position)}\n${meta}`);
      } else {
        const dims = cat?.dims ?? { w: 0.6, d: 1.2, h: 2.3 };
        const bid = boxFor(`eq-${e.catalogId}`, [dims.w, dims.h, dims.d], cat?.color ?? '#808080');
        const [x, y, z] = e.transform.yUp.position;
        nodes.push(`[node name="${name}" type="MeshInstance3D" parent="${parent}"]\ntransform = ${transformY(e.transform.yUp.rotationYDeg, [x, r4(y + dims.h / 2), z])}\nmesh = SubResource("${bid}")\n${meta}`);
      }
    }

    const cNamer = uniqueNamer();
    for (const c of scene.containments.filter((q) => q.hallId === hall.id)) {
      const color = c.containment === 'hot-aisle' ? '#ff6a3d' : '#3da5ff';
      const bid = boxFor(`cont-${c.id}`, c.yUp.size, color, 0.22);
      nodes.push(`[node name="${cNamer(c.id)}" type="MeshInstance3D" parent="${hallNode}/Containment"]\ntransform = ${transformY(0, c.yUp.center)}\nmesh = SubResource("${bid}")\nmetadata/aidc_kind = "${c.containment}"`);
    }
    const kNamer = uniqueNamer();
    for (const k of hall.keepouts) {
      const bid = boxFor(`ko-${k.id}`, k.yUp.size, k.kind === 'column' ? '#9a9a9a' : '#e0c040', k.kind === 'column' ? 1 : 0.4);
      nodes.push(`[node name="${kNamer(k.id)}" type="MeshInstance3D" parent="${hallNode}/Keepouts"]\ntransform = ${transformY(0, k.yUp.center)}\nmesh = SubResource("${bid}")`);
    }
  }

  const header = `[gd_scene load_steps=${ext.length + sub.length + 1} format=3]`;
  const text = [header, '', ...ext, ...(ext.length ? [''] : []), ...sub.map((s) => `${s}`), ...nodes.map((n) => `${n}\n`)].join('\n');
  return { 'scene.tscn': text };
}
