#!/usr/bin/env lua
-- test-config-circuit.lua
--
-- Tests for config-circuit.lua

local cc = require("config-circuit")

local passed = 0
local failed = 0

local function assert_eq(actual, expected, label)
    if actual == expected then
        passed = passed + 1
    else
        failed = failed + 1
        io.stderr:write(string.format(
            "FAIL: %s — expected %s, got %s\n", label,
            tostring(expected), tostring(actual)))
    end
end

local function assert_near(actual, expected, tol, label)
    if math.abs(actual - expected) <= tol then
        passed = passed + 1
    else
        failed = failed + 1
        io.stderr:write(string.format(
            "FAIL: %s — expected ~%s, got %s (tol %s)\n", label,
            tostring(expected), tostring(actual), tostring(tol)))
    end
end

local function assert_error(fn, label)
    local ok, _ = pcall(fn)
    if not ok then
        passed = passed + 1
    else
        failed = failed + 1
        io.stderr:write(string.format("FAIL: %s — expected error\n", label))
    end
end

---------------------------------------------------------------------------
-- 1. Per-segment colors are respected for cruise segments
---------------------------------------------------------------------------

do
    local circuit = {
        name = "test-circuit",
        default_color = "#ffffff",
        segments = {
            { type = "accel",  color = "#ff0000", duration = 5,
              acceleration = 2, initial_speed = 0 },
            { type = "cruise", color = "#00ff00", duration = 10,
              acceleration = 0, initial_speed = 10 },
            { type = "cruise", color = "#0000ff", duration = 8,
              acceleration = 0, initial_speed = 10 },
            { type = "decel",  color = "#ffff00", duration = 4,
              acceleration = -2, initial_speed = 10 },
        },
    }

    local result = cc.process(circuit)

    assert_eq(#result.segments, 4, "segment count")
    assert_eq(result.segments[1].color, "#ff0000", "accel color")
    assert_eq(result.segments[2].color, "#00ff00", "cruise 1 color")
    assert_eq(result.segments[3].color, "#0000ff", "cruise 2 color")
    assert_eq(result.segments[4].color, "#ffff00", "decel color")
end

---------------------------------------------------------------------------
-- 2. Default color fallback
---------------------------------------------------------------------------

do
    local circuit = {
        name = "defaults",
        default_color = "#aabbcc",
        segments = {
            { type = "cruise", duration = 5, acceleration = 0,
              initial_speed = 10 },
            { type = "cruise", color = "#112233", duration = 5,
              acceleration = 0, initial_speed = 10 },
        },
    }

    local result = cc.process(circuit)

    assert_eq(result.segments[1].color, "#aabbcc",
        "cruise without color gets default")
    assert_eq(result.segments[2].color, "#112233",
        "cruise with explicit color keeps it")
end

---------------------------------------------------------------------------
-- 3. Distance → duration for cruise (acceleration = 0)
---------------------------------------------------------------------------

do
    -- cruise at 10 m/s for 50 m  ⟹  t = 50/10 = 5 s
    local seg = cc.resolve_segment({
        type = "cruise",
        distance = 50,
        acceleration = 0,
        initial_speed = 10,
    })
    assert_near(seg.duration, 5.0, 1e-9, "cruise distance->duration")
end

---------------------------------------------------------------------------
-- 4. Distance → duration with constant acceleration
---------------------------------------------------------------------------

do
    -- v0 = 0, a = 2:  s = 0.5*a*t^2  ⟹  t = sqrt(2s/a)
    -- s = 100, a = 2  ⟹  t = sqrt(100) = 10
    local seg = cc.resolve_segment({
        type = "accel",
        distance = 100,
        acceleration = 2,
        initial_speed = 0,
    })
    assert_near(seg.duration, 10.0, 1e-9, "accel from rest distance->duration")
end

do
    -- v0 = 5, a = 2, s = 50
    -- 0.5*2*t^2 + 5*t - 50 = 0  ⟹  t^2 + 5t - 50 = 0
    -- t = (-5 + sqrt(25 + 200)) / 2 = (-5 + 15) / 2 = 5
    local seg = cc.resolve_segment({
        type = "accel",
        distance = 50,
        acceleration = 2,
        initial_speed = 5,
    })
    assert_near(seg.duration, 5.0, 1e-9, "accel with initial speed distance->duration")
end

---------------------------------------------------------------------------
-- 5. Duration already set – distance does not override
---------------------------------------------------------------------------

do
    local seg = cc.resolve_segment({
        type = "cruise",
        distance = 999,
        duration = 7,
        acceleration = 0,
        initial_speed = 10,
    })
    assert_eq(seg.duration, 7, "explicit duration not overridden by distance")
end

---------------------------------------------------------------------------
-- 6. Full circuit with mixed duration / distance
---------------------------------------------------------------------------

do
    local circuit = {
        name = "mixed",
        default_color = "#000000",
        segments = {
            { type = "accel",  color = "#ff0000",
              distance = 100, acceleration = 2, initial_speed = 0 },
            { type = "cruise", color = "#00ff00",
              distance = 50,  acceleration = 0, initial_speed = 10 },
            { type = "decel",  color = "#0000ff",
              duration = 3,   acceleration = -2, initial_speed = 10 },
        },
    }

    local result = cc.process(circuit)

    assert_eq(#result.segments, 3, "mixed segment count")
    -- accel: t = sqrt(2*100/2) = 10
    assert_near(result.segments[1].duration, 10.0, 1e-9,
        "mixed accel distance->duration")
    -- cruise: t = 50/10 = 5
    assert_near(result.segments[2].duration, 5.0, 1e-9,
        "mixed cruise distance->duration")
    -- decel: duration given directly
    assert_eq(result.segments[3].duration, 3,
        "mixed decel explicit duration")

    -- colors
    assert_eq(result.segments[1].color, "#ff0000", "mixed accel color")
    assert_eq(result.segments[2].color, "#00ff00", "mixed cruise color")
    assert_eq(result.segments[3].color, "#0000ff", "mixed decel color")
end

---------------------------------------------------------------------------
-- 7. Error cases
---------------------------------------------------------------------------

assert_error(function()
    cc.compute_duration(50, 0, 0)
end, "cruise with zero speed errors")

assert_error(function()
    cc.compute_duration(0, 2, 10)
end, "zero distance errors")

assert_error(function()
    cc.compute_duration(50, 2, -1)
end, "negative initial_speed errors")

---------------------------------------------------------------------------
-- Summary
---------------------------------------------------------------------------

print(string.format("\n%d passed, %d failed", passed, failed))
if failed > 0 then
    os.exit(1)
end
