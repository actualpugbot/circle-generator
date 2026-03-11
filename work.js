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
    const parsedWidth = Number.parseInt(payload.width, 10);
    const widthInput = Number.isFinite(parsedWidth)
        ? parsedWidth
        : normalizeInteger(payload.radius, 1) * 2 + 1;
    const width = normalizeWidth(widthInput);
    const center_offset = (width - 1) / 2;
    const thickness = clampInteger(payload.thickness, 1, getThicknessLimitForWidth(width));
    const effective_thickness = getEffectiveThickness(thickness);
    const center_x = normalizeInteger(payload.centerX, 0);
    const center_y = normalizeInteger(payload.centerY, 64);
    const center_z = normalizeInteger(payload.centerZ, 0);

    const relative_points = [];

    if (thickness === 1) {
        buildThinCirclePoints(width, relative_points);
    } else {
        const radius_outer = center_offset + 0.5;
        const radius_outer_sq = radius_outer * radius_outer;
        const radius_inner = Math.max(0, center_offset - effective_thickness + 0.15);
        const radius_inner_sq = radius_inner * radius_inner;

        for (let row = 0; row < width; row += 1) {
            const z = center_offset - row;
            for (let column = 0; column < width; column += 1) {
                const x = column - center_offset;
                const distance_sq = x * x + z * z;
                const include = distance_sq <= radius_outer_sq && distance_sq >= radius_inner_sq;

                if (!include) {
                    continue;
                }

                relative_points.push({ x: x, z: z });
            }
        }
    }

    const absolute_points = relative_points.map(function(point) {
        return {
            x: center_x + point.x,
            y: center_y,
            z: center_z + point.z,
        };
    });

    return {
        width: width,
        centerOffset: center_offset,
        radius: center_offset,
        diameter: width,
        thickness: thickness,
        center: {
            x: center_x,
            y: center_y,
            z: center_z,
        },
        blocks: relative_points.length,
        circumference: roundTo(2 * Math.PI * center_offset, 2),
        areaEstimate: roundTo(Math.PI * center_offset * center_offset, 2),
        relativePoints: relative_points,
        absolutePoints: absolute_points,
    };
}

function buildThinCirclePoints(width, relative_points) {
    const radius = width / 2;
    const half_step_offset = (width % 2 === 0) ? 0.5 : 0;
    let x = Math.floor(radius - half_step_offset);
    let z = 0;
    const point_keys = new Set();

    while (x >= z) {
        const plot_x = x + half_step_offset;
        const plot_z = z + half_step_offset;
        addMirroredOctantPoints(plot_x, plot_z, point_keys, relative_points);

        z += 1;

        const decision = plot_x * plot_x + Math.pow(z + half_step_offset, 2) - radius * radius;
        if (decision >= 0) {
            x -= 1;
        }
    }

    relative_points.sort(function(pointA, pointB) {
        if (pointA.z !== pointB.z) {
            return pointB.z - pointA.z;
        }
        return pointA.x - pointB.x;
    });
}

function addMirroredOctantPoints(x, z, point_keys, relative_points) {
    addRelativePoint(x, z, point_keys, relative_points);
    addRelativePoint(z, x, point_keys, relative_points);
    addRelativePoint(-z, x, point_keys, relative_points);
    addRelativePoint(-x, z, point_keys, relative_points);
    addRelativePoint(-x, -z, point_keys, relative_points);
    addRelativePoint(-z, -x, point_keys, relative_points);
    addRelativePoint(z, -x, point_keys, relative_points);
    addRelativePoint(x, -z, point_keys, relative_points);
}

function addRelativePoint(x, z, point_keys, relative_points) {
    const key = x + "," + z;
    if (point_keys.has(key)) {
        return;
    }

    point_keys.add(key);
    relative_points.push({ x: x, z: z });
}

function clampInteger(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, normalizeInteger(value, minimum)));
}

function normalizeWidth(value) {
    return clampInteger(value, 1, 4097);
}

function getThicknessLimitForWidth(width) {
    return Math.max(1, Math.ceil((width - 1) / 2));
}

function getEffectiveThickness(thickness) {
    if (thickness <= 1) {
        // Keep "1" as the thinnest option without changing the heavier presets.
        return 0.75;
    }
    return thickness;
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
