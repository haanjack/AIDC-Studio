extends Camera3D
## Orbit / pan / zoom camera with WASD target movement.

@export var target: Vector3 = Vector3.ZERO
@export var distance: float = 40.0
@export var yaw_deg: float = -35.0
@export var pitch_deg: float = -40.0
@export var move_speed: float = 12.0

var _rotating: bool = false
var _panning: bool = false


func _ready() -> void:
	_apply()


func focus(center: Vector3, radius: float) -> void:
	target = center
	distance = maxf(radius * 2.2, 5.0)
	_apply()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			_rotating = mb.pressed
		elif mb.button_index == MOUSE_BUTTON_RIGHT or mb.button_index == MOUSE_BUTTON_MIDDLE:
			_panning = mb.pressed
		elif mb.button_index == MOUSE_BUTTON_WHEEL_UP and mb.pressed:
			distance = maxf(1.0, distance * 0.9)
			_apply()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN and mb.pressed:
			distance = minf(2000.0, distance * 1.1)
			_apply()
	elif event is InputEventMouseMotion:
		var mm := event as InputEventMouseMotion
		if _rotating:
			yaw_deg -= mm.relative.x * 0.3
			pitch_deg = clampf(pitch_deg - mm.relative.y * 0.3, -89.0, 5.0)
			_apply()
		elif _panning:
			var right := global_transform.basis.x
			var forward := Vector3(-global_transform.basis.z.x, 0.0, -global_transform.basis.z.z).normalized()
			target += (-right * mm.relative.x + forward * mm.relative.y) * distance * 0.0015
			_apply()


func _process(delta: float) -> void:
	var dir := Vector3.ZERO
	if Input.is_key_pressed(KEY_W):
		dir.z -= 1.0
	if Input.is_key_pressed(KEY_S):
		dir.z += 1.0
	if Input.is_key_pressed(KEY_A):
		dir.x -= 1.0
	if Input.is_key_pressed(KEY_D):
		dir.x += 1.0
	if dir != Vector3.ZERO:
		target += dir.normalized().rotated(Vector3.UP, deg_to_rad(yaw_deg)) * move_speed * delta
		_apply()


func _apply() -> void:
	var offset := Vector3(0.0, 0.0, distance)
	offset = offset.rotated(Vector3.RIGHT, deg_to_rad(pitch_deg)).rotated(Vector3.UP, deg_to_rad(yaw_deg))
	position = target + offset
	if position.distance_to(target) > 0.001:
		look_at_from_position(position, target, Vector3.UP)
