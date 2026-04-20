-- config-circuit.lua
--
-- Circuit path configuration module.
--
-- A circuit is composed of ordered segments. Each segment describes a
-- section of the path with its own kinematic properties (speed,
-- acceleration) and visual properties (color).
--
-- Segment types:
--   "accel"  – accelerating section
--   "cruise" – constant-speed section (acceleration = 0)
--   "decel"  – decelerating / braking section
--
-- Each segment may specify its length either as a *duration* (seconds)
-- or as a *distance* (arc length).  When distance is given the module
-- computes the matching duration from the segment's acceleration and
-- initial_speed using standard kinematics.

local config_circuit = {}

---------------------------------------------------------------------------
-- Kinematics helpers
---------------------------------------------------------------------------

--- Compute the duration needed to cover `distance` starting at
--- `initial_speed` with constant `acceleration`.
---
--- For a cruise segment (acceleration == 0):  t = distance / initial_speed
---
--- For an accelerating / decelerating segment the quadratic
---   distance = initial_speed * t + 0.5 * acceleration * t^2
--- is solved for the positive root.
---
--- @param distance      number  arc length of the segment (must be > 0)
--- @param acceleration  number  constant acceleration (may be 0)
--- @param initial_speed number  speed at the start of the segment (>= 0)
--- @return number duration in seconds
function config_circuit.compute_duration(distance, acceleration, initial_speed)
    assert(distance > 0, "distance must be positive")
    assert(initial_speed >= 0, "initial_speed must be non-negative")

    if acceleration == 0 then
        assert(initial_speed > 0,
            "initial_speed must be positive when acceleration is zero")
        return distance / initial_speed
    end

    -- 0.5*a*t^2 + v0*t - s = 0  ⟹  t = (-v0 ± √(v0²+2·a·s)) / a
    local discriminant = initial_speed * initial_speed + 2 * acceleration * distance
    assert(discriminant >= 0,
        "unreachable distance: discriminant is negative")

    local sqrt_d = math.sqrt(discriminant)
    local t1 = (-initial_speed + sqrt_d) / acceleration
    local t2 = (-initial_speed - sqrt_d) / acceleration

    -- Pick the positive root.
    local t = math.max(t1, t2)
    assert(t > 0, "no positive duration found for the given parameters")
    return t
end

---------------------------------------------------------------------------
-- Segment resolution
---------------------------------------------------------------------------

--- Resolve a single segment: if `distance` is provided but `duration` is
--- not, compute `duration` from the kinematics.  All original fields
--- (including `color`) are preserved in the returned table.
---
--- @param segment table  raw segment from the configuration
--- @return table resolved copy of the segment with `duration` filled in
function config_circuit.resolve_segment(segment)
    local resolved = {}
    for k, v in pairs(segment) do
        resolved[k] = v
    end

    if resolved.distance and not resolved.duration then
        local accel = resolved.acceleration or 0
        local v0    = resolved.initial_speed or 0
        resolved.duration = config_circuit.compute_duration(
            resolved.distance, accel, v0)
    end

    return resolved
end

---------------------------------------------------------------------------
-- Circuit processing
---------------------------------------------------------------------------

--- Process a full circuit definition.
---
--- Each segment in `circuit.segments` is resolved (distance → duration)
--- and its **own** `color` field is respected.  If a segment does not
--- specify a color the circuit-level `default_color` is used as a
--- fallback.
---
--- NOTE – Previous versions contained a bug where the color of cruise
--- segments was overwritten with a single shared value.  The fix is to
--- always read `color` from the individual segment table first.
---
--- @param circuit table  { name, default_color, segments = { … } }
--- @return table processed circuit with resolved segments
function config_circuit.process(circuit)
    local result = {
        name     = circuit.name,
        segments = {},
    }

    for _, segment in ipairs(circuit.segments) do
        local resolved = config_circuit.resolve_segment(segment)

        -- Per-segment color takes priority; fall back to the circuit default.
        resolved.color = segment.color or circuit.default_color

        result.segments[#result.segments + 1] = resolved
    end

    return result
end

return config_circuit
