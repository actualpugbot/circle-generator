self.onmessage = function(event) {
    const message = event.data || {};
    if (message.msg !== "generate") {
        return;
    }

    const request_id = message.requestId;

    try {
        const result = buildCircle(message.payload || {});
        self.postMessage({
            msg: "complete",
            requestId: request_id,
            data: result,
        });
    } catch (error) {
        self.postMessage({
            msg: "error",
            requestId: request_id,
            error: error && error.message ? error.message : "Unknown generation error",
        });
    }
};

function buildCircle(payload) {
    const radius = clampInteger(payload.radius, 1, 2048);
    const thickness = clampInteger(payload.thickness, 1, Math.max(1, radius));
    const center_x = normalizeInteger(payload.centerX, 0);
    const center_y = normalizeInteger(payload.centerY, 64);
    const center_z = normalizeInteger(payload.centerZ, 0);

    const radius_outer = radius + 0.35;
    const radius_outer_sq = radius_outer * radius_outer;
    const radius_inner = Math.max(0, radius - thickness + 0.15);
    const radius_inner_sq = radius_inner * radius_inner;

    const relative_points = [];
    const absolute_points = [];

    for (let z = -radius; z <= radius; z += 1) {
        for (let x = -radius; x <= radius; x += 1) {
            const distance_sq = x * x + z * z;
            const include = distance_sq <= radius_outer_sq && distance_sq >= radius_inner_sq;

            if (!include) {
                continue;
            }

            relative_points.push({ x: x, z: z });
            absolute_points.push({
                x: center_x + x,
                y: center_y,
                z: center_z + z,
            });
        }
    }

    return {
        radius: radius,
        diameter: radius * 2 + 1,
        thickness: thickness,
        center: {
            x: center_x,
            y: center_y,
            z: center_z,
        },
        blocks: relative_points.length,
        circumference: roundTo(2 * Math.PI * radius, 2),
        areaEstimate: roundTo(Math.PI * radius * radius, 2),
        relativePoints: relative_points,
        absolutePoints: absolute_points,
    };
}

function clampInteger(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, normalizeInteger(value, minimum)));
}

function normalizeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return parsed;
}

function roundTo(number, precision) {
    const multiplier = Math.pow(10, precision);
    return Math.round(number * multiplier) / multiplier;
}
