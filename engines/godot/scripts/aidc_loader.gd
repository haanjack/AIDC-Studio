extends Node3D
## AIDC Studio layout loader for Godot 4.
##
## Reads an "aidc.layout/1" export (layout.json) and builds the data hall: floor, keepouts,
## equipment (glTF models from res://models/ when present, colored boxes otherwise) and
## aisle containment. Command-line user args (after `--`):
##   --layout=<path>        layout file (res://, user:// or absolute path). Default res://layout.json
##   --models=<dir>         model directory. Default res://models/
##   --scene=<res path>     instance a pre-built AIDC scene.tscn instead of building from JSON
##   --labels               show equipment tags
##   --quit-after-load      exit after loading (CI / headless verification)

@export_file("*.json") var layout_path: String = "res://layout.json"
@export var models_dir: String = "res://models/"
@export var show_labels: bool = false

const CONTAINMENT_COLORS := {
	"hot-aisle": Color(1.0, 0.42, 0.24, 0.22),
	"cold-aisle": Color(0.24, 0.65, 1.0, 0.22),
}

var layout: Dictionary = {}
var site_root: Node3D
var stats: Dictionary = {}

var _containment_nodes: Array[Node3D] = []
var _label_nodes: Array[Node3D] = []
var _ceiling_nodes: Array[Node3D] = []
var _box_meshes: Dictionary = {}
var _packed_models: Dictionary = {}
var _runtime_models: Dictionary = {}
var _quit_after_load: bool = false
var _scene_path: String = ""
var _stats_label: Label


func _ready() -> void:
	_parse_args()
	if has_node("Sun"):
		$Sun.rotation_degrees = Vector3(-55.0, -35.0, 0.0)
	var ok: bool
	if _scene_path != "":
		ok = load_prebuilt_scene(_scene_path)
	else:
		ok = load_layout(layout_path)
	_build_ui()
	if ok:
		_frame_camera()
	if _quit_after_load:
		print("AIDC: quit-after-load (ok=%s)" % ok)
		get_tree().quit(0 if ok else 1)


func _parse_args() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--layout="):
			layout_path = arg.substr("--layout=".length())
		elif arg.begins_with("--models="):
			models_dir = arg.substr("--models=".length())
			if not models_dir.ends_with("/"):
				models_dir += "/"
		elif arg.begins_with("--scene="):
			_scene_path = arg.substr("--scene=".length())
		elif arg == "--labels":
			show_labels = true
		elif arg == "--quit-after-load":
			_quit_after_load = true


# ───────────────────────────── loading ─────────────────────────────

func load_layout(path: String) -> bool:
	if not FileAccess.file_exists(path):
		push_error("AIDC: layout file not found: %s" % path)
		return false
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(parsed) != TYPE_DICTIONARY or str(parsed.get("schema", "")) != "aidc.layout/1":
		push_error("AIDC: %s is not an aidc.layout/1 file" % path)
		return false
	layout = parsed
	_clear()
	site_root = Node3D.new()
	site_root.name = "Site"
	add_child(site_root)

	var catalog: Dictionary = layout.get("catalog", {})
	var hall_nodes: Dictionary = {}
	for hall: Dictionary in layout.get("halls", []):
		var hall_node := Node3D.new()
		hall_node.name = _safe_name(str(hall.get("name", "Hall")))
		site_root.add_child(hall_node)
		hall_nodes[hall["id"]] = hall_node
		_add_box(hall_node, "Floor", hall["floor"]["yUp"], Color(0.56, 0.58, 0.6, 1.0))
		var origin: Dictionary = hall["origin"]
		var w: float = hall["width"]
		var d: float = hall["depth"]
		var ch: float = hall["clearHeight"]
		var ceiling := _add_box(hall_node, "Ceiling", {
			"center": [origin["x"] + w * 0.5, ch + 0.05, -(origin["y"] + d * 0.5)],
			"size": [w, 0.1, d],
		}, Color(0.85, 0.86, 0.88, 0.25))
		ceiling.visible = false
		_ceiling_nodes.append(ceiling)
		for ko: Dictionary in hall.get("keepouts", []):
			var is_column: bool = str(ko.get("kind", "")) == "column"
			_add_box(hall_node, _safe_name(str(ko["id"])), ko["yUp"], Color(0.6, 0.6, 0.6, 1.0) if is_column else Color(0.9, 0.75, 0.25, 0.4))

	var with_models := 0
	var equipment_count := 0
	var it_kw := 0.0
	for e: Dictionary in layout.get("equipment", []):
		var hall_node: Node3D = hall_nodes.get(e["hallId"])
		if hall_node == null:
			continue
		var cat: Dictionary = catalog.get(e["catalogId"], {})
		var node := _make_equipment(e, cat)
		hall_node.add_child(node)
		equipment_count += 1
		if node.get_meta("aidc_has_model", false):
			with_models += 1
		it_kw += float(cat.get("nameplateKW", 0.0))

	for c: Dictionary in layout.get("containments", []):
		var hall_node: Node3D = hall_nodes.get(c["hallId"])
		if hall_node == null:
			continue
		var color: Color = CONTAINMENT_COLORS.get(str(c.get("containment", "hot-aisle")), Color(1, 1, 1, 0.2))
		var box := _add_box(hall_node, _safe_name(str(c["id"])), c["yUp"], color)
		_containment_nodes.append(box)

	stats = {
		"halls": hall_nodes.size(),
		"equipment": equipment_count,
		"with_models": with_models,
		"containments": _containment_nodes.size(),
		"it_kw": it_kw,
	}
	print("AIDC: loaded %d equipment (%d with glTF models), %d containments, %d halls, %.0f kW nameplate from %s" % [
		equipment_count, with_models, _containment_nodes.size(), hall_nodes.size(), it_kw, path])
	return true


func load_prebuilt_scene(path: String) -> bool:
	if not ResourceLoader.exists(path):
		push_error("AIDC: scene not found: %s" % path)
		return false
	var packed: PackedScene = load(path)
	_clear()
	site_root = packed.instantiate()
	add_child(site_root)
	stats = {"equipment": _count_meta(site_root, "aidc_id")}
	print("AIDC: instanced scene %s with %d equipment nodes" % [path, stats["equipment"]])
	return true


func _make_equipment(e: Dictionary, cat: Dictionary) -> Node3D:
	var t: Dictionary = e["transform"]["yUp"]
	var p: Array = t["position"]
	var node := Node3D.new()
	node.name = _safe_name(str(e["tag"]))
	node.position = Vector3(p[0], p[1], p[2])
	node.rotation_degrees = Vector3(0.0, float(t["rotationYDeg"]), 0.0)
	node.set_meta("aidc_id", e["id"])
	node.set_meta("aidc_tag", e["tag"])
	node.set_meta("aidc_catalog_id", e["catalogId"])
	node.set_meta("aidc_category", e.get("category", "other"))

	var dims: Dictionary = cat.get("dims", {"w": 0.6, "d": 1.2, "h": 2.3})
	var glb: Variant = cat.get("glb")
	var model: Node3D = null
	if typeof(glb) == TYPE_STRING and str(glb) != "":
		model = _instance_model(models_dir + str(glb))
	if model != null:
		node.add_child(model)
		node.set_meta("aidc_has_model", true)
	else:
		var mi := MeshInstance3D.new()
		mi.name = "Box"
		var size := Vector3(float(dims["w"]), float(dims["h"]), float(dims["d"]))
		mi.mesh = _box_mesh(str(e["catalogId"]), size, Color.html(str(cat.get("color", "#808080"))))
		mi.position.y = size.y * 0.5
		node.add_child(mi)

	var label := Label3D.new()
	label.name = "Tag"
	label.text = str(e["tag"])
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.pixel_size = 0.004
	label.font_size = 40
	label.position.y = float(dims["h"]) + 0.25
	label.visible = show_labels
	node.add_child(label)
	_label_nodes.append(label)
	return node


func _instance_model(path: String) -> Node3D:
	if path.begins_with("res://"):
		if not _packed_models.has(path):
			_packed_models[path] = load(path) if ResourceLoader.exists(path) else null
		var packed: PackedScene = _packed_models[path]
		return packed.instantiate() if packed != null else null
	# absolute / user:// glTF loaded at runtime (no editor import step)
	if not _runtime_models.has(path):
		var generated: Node = null
		if FileAccess.file_exists(path):
			var doc := GLTFDocument.new()
			var state := GLTFState.new()
			if doc.append_from_file(path, state) == OK:
				generated = doc.generate_scene(state)
		_runtime_models[path] = generated
	var template: Node = _runtime_models[path]
	return template.duplicate() if template != null else null


func _box_mesh(key: String, size: Vector3, color: Color) -> BoxMesh:
	if not _box_meshes.has(key):
		var mesh := BoxMesh.new()
		mesh.size = size
		var mat := StandardMaterial3D.new()
		mat.albedo_color = color
		mat.roughness = 0.6
		mesh.material = mat
		_box_meshes[key] = mesh
	return _box_meshes[key]


func _add_box(parent: Node3D, node_name: String, box: Dictionary, color: Color) -> MeshInstance3D:
	var c: Array = box["center"]
	var s: Array = box["size"]
	var mi := MeshInstance3D.new()
	mi.name = node_name
	var mesh := BoxMesh.new()
	mesh.size = Vector3(s[0], s[1], s[2])
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.roughness = 0.8
	if color.a < 1.0:
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		mat.cull_mode = BaseMaterial3D.CULL_DISABLED
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mesh.material = mat
	mi.mesh = mesh
	mi.position = Vector3(c[0], c[1], c[2])
	parent.add_child(mi)
	return mi


func _clear() -> void:
	if site_root != null:
		site_root.queue_free()
		site_root = null
	_containment_nodes.clear()
	_label_nodes.clear()
	_ceiling_nodes.clear()


func _count_meta(n: Node, key: String) -> int:
	var total := 1 if n.has_meta(key) else 0
	for child in n.get_children():
		total += _count_meta(child, key)
	return total


func _safe_name(s: String) -> String:
	return s.validate_node_name()


# ───────────────────────────── UI & camera ─────────────────────────────

func set_containment_visible(v: bool) -> void:
	for n in _containment_nodes:
		n.visible = v


func set_labels_visible(v: bool) -> void:
	show_labels = v
	for n in _label_nodes:
		n.visible = v


func set_ceiling_visible(v: bool) -> void:
	for n in _ceiling_nodes:
		n.visible = v


func _build_ui() -> void:
	var layer := get_node_or_null("UI") as CanvasLayer
	if layer == null:
		layer = CanvasLayer.new()
		layer.name = "UI"
		add_child(layer)
	var panel := PanelContainer.new()
	panel.position = Vector2(12, 12)
	layer.add_child(panel)
	var box := VBoxContainer.new()
	panel.add_child(box)
	var title := Label.new()
	title.text = str(layout.get("project", {}).get("name", "AIDC Studio"))
	box.add_child(title)
	_stats_label = Label.new()
	_stats_label.text = "Equipment: %s  |  Containments: %s  |  IT: %.1f MW" % [
		stats.get("equipment", 0), stats.get("containments", 0), float(stats.get("it_kw", 0.0)) / 1000.0]
	box.add_child(_stats_label)
	_add_toggle(box, "Containment", true, set_containment_visible)
	_add_toggle(box, "Labels", show_labels, set_labels_visible)
	_add_toggle(box, "Ceiling", false, set_ceiling_visible)
	var hint := Label.new()
	hint.text = "LMB orbit · RMB pan · wheel zoom · WASD move"
	hint.modulate = Color(1, 1, 1, 0.6)
	box.add_child(hint)


func _add_toggle(parent: Control, text: String, pressed: bool, callback: Callable) -> void:
	var cb := CheckBox.new()
	cb.text = text
	cb.button_pressed = pressed
	cb.toggled.connect(callback)
	parent.add_child(cb)


func _frame_camera() -> void:
	var cam := get_node_or_null("Camera")
	if cam == null or not cam.has_method("focus"):
		return
	var halls: Array = layout.get("halls", [])
	if halls.is_empty():
		return
	var h: Dictionary = halls[0]
	var center := Vector3(h["origin"]["x"] + h["width"] * 0.5, 1.0, -(h["origin"]["y"] + h["depth"] * 0.5))
	cam.focus(center, maxf(h["width"], h["depth"]) * 0.5)
