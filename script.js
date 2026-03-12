let worker = null;
let lastResult = null;
let activeRequestToken = 0;
let completedPointKeys = new Set();
let drawablePointKeys = new Set();
let isPreviewDragging = false;
let didPreviewDragMove = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartScrollLeft = 0;
let dragStartScrollTop = 0;
let ignoreCanvasClickUntil = 0;
let currentZoom = data.zoom.default;
let measurementOverlayCache = new WeakMap();

const WORKER_CACHE_KEY = 3;
const THEME_STORAGE_KEY = "circle_generator_theme";
const DARK_THEME = "dark";
const LIGHT_THEME = "light";
const VIEW_MODE_FULL = "full";
const VIEW_MODE_NE = "ne";
const VIEW_MODE_NW = "nw";
const VIEW_MODE_SE = "se";
const VIEW_MODE_SW = "sw";
const PREVIEW_PADDING_MIN_PX = 420;
const PREVIEW_PADDING_MAX_PX = 1400;
const PREVIEW_PADDING_RATIO = 0.6;
const PREVIEW_PADDING_MIN_CELLS = 18;
const PREVIEW_VIEWPORT_BUFFER_PX = 420;
const MAX_CANVAS_SIDE_PX = 32000;
const MEASUREMENT_OVERLAY_MAX_ATTEMPTS = 6;

const ui = {};

applyInitialTheme();

window.addEventListener("load", initializeApp);

async function initializeApp() {
    cacheElements();
    setupThemeToggle();
    initializeInputs();
    updateDownloadButtonState();
    setupNumberSteppers();
    bindEvents();
    document.title = data.appTitle || "Circle Generator";
    updateThemeToggle(normalizeTheme(document.documentElement.getAttribute("data-theme")));

    resetWorker();
    requestGeneration();
}

function setupNumberSteppers() {
    const stepperButtons = document.querySelectorAll(".number-stepper[data-step-target][data-step-direction]");
    stepperButtons.forEach(function(button) {
        button.addEventListener("mousedown", function(event) {
            // Keep mouse clicks from stealing focus and triggering focus-within flash.
            event.preventDefault();
        });

        button.addEventListener("click", function() {
            if (button.disabled) {
                return;
            }

            const targetId = button.getAttribute("data-step-target");
            const direction = button.getAttribute("data-step-direction") === "down" ? -1 : 1;
            const input = document.getElementById(targetId);
            if (!input || input.disabled) {
                return;
            }

            const step = Number.parseFloat(input.step);
            const min = Number.parseFloat(input.min);
            const max = Number.parseFloat(input.max);
            const current = Number.parseFloat(input.value);
            const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
            let nextValue = Number.isFinite(current)
                ? current + direction * safeStep
                : (direction > 0 ? (Number.isFinite(min) ? min : 0) : (Number.isFinite(max) ? max : 0));

            if (Number.isFinite(min)) {
                nextValue = Math.max(min, nextValue);
            }
            if (Number.isFinite(max)) {
                nextValue = Math.min(max, nextValue);
            }

            input.value = String(nextValue);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
    });

    syncNumberStepperStates();
}

function syncNumberStepperStates() {
    const stepperButtons = document.querySelectorAll(".number-stepper[data-step-target][data-step-direction]");
    stepperButtons.forEach(function(button) {
        const targetId = button.getAttribute("data-step-target");
        const direction = button.getAttribute("data-step-direction");
        const input = document.getElementById(targetId);
        if (!input || input.disabled) {
            button.disabled = true;
            return;
        }

        if (direction !== "down") {
            button.disabled = false;
            return;
        }

        const minimum = Number.parseFloat(input.min);
        const current = Number.parseFloat(input.value);
        button.disabled = Number.isFinite(minimum) && Number.isFinite(current) && current <= minimum;
    });
}

function handleDimensionInput() {
    syncNumberStepperStates();
    requestGeneration();
}

function cacheElements() {
    ui.form = document.getElementById("generator-form");
    ui.width = document.getElementById("width");
    ui.thickness = document.getElementById("thickness");
    ui.downloadImage = document.getElementById("download-image");
    ui.zoom = document.getElementById("zoom");
    ui.zoomValue = document.getElementById("zoom-value");
    ui.viewMode = document.getElementById("view-mode");
    ui.showMeasurements = document.getElementById("show-measurements");
    ui.previewShell = document.getElementById("preview-shell");
    ui.canvas = document.getElementById("circle-canvas");
    ui.previewSize = document.getElementById("preview-size");
    ui.error = document.getElementById("error");
    ui.errorMessage = document.getElementById("error-message");
}

function initializeInputs() {
    ui.width.min = String(data.minWidth);
    ui.width.max = String(data.maxWidth);
    ui.width.value = String(data.defaultWidth);

    ui.thickness.min = String(data.minThickness);
    ui.thickness.max = String(getThicknessLimitForWidth(data.maxWidth));
    ui.thickness.value = String(data.defaultThickness);

    currentZoom = clampNumber(data.zoom.default, data.zoom.min, data.zoom.max, data.zoom.default);
    if (ui.zoom) {
        ui.zoom.min = String(data.zoom.sliderMin);
        ui.zoom.max = String(data.zoom.sliderMax);
        ui.zoom.step = String(data.zoom.sliderStep);
        syncZoomSliderToCurrent();
    }
    if (ui.zoomValue) {
        updateZoomLabel();
    }
}

function bindEvents() {
    ui.form.addEventListener("submit", function(event) {
        event.preventDefault();
        requestGeneration();
    });

    ui.width.addEventListener("input", handleDimensionInput);
    ui.thickness.addEventListener("input", handleDimensionInput);
    ui.width.addEventListener("change", handleDimensionInput);
    ui.thickness.addEventListener("change", handleDimensionInput);

    if (ui.zoom) {
        ui.zoom.addEventListener("input", function() {
            currentZoom = sliderValueToZoom(ui.zoom.value);
            updateZoomLabel();
            if (lastResult) {
                drawPreview(lastResult);
            }
        });
    }
    ui.viewMode.addEventListener("change", function() {
        if (lastResult) {
            renderResult(lastResult, { recenter: true });
        }
    });
    if (ui.showMeasurements) {
        ui.showMeasurements.addEventListener("change", function() {
            if (lastResult) {
                drawPreview(lastResult);
            }
        });
    }

    ui.previewShell.addEventListener("wheel", handlePreviewWheel, { passive: false });
    ui.previewShell.addEventListener("mousedown", handlePreviewDragStart);
    window.addEventListener("mousemove", handlePreviewDragMove);
    window.addEventListener("mouseup", handlePreviewDragEnd);
    ui.canvas.addEventListener("click", handleCanvasClick);
    if (ui.downloadImage) {
        ui.downloadImage.addEventListener("click", handleDownloadImageClick);
    }
}

function requestGeneration() {
    if (!worker) {
        resetWorker();
    }

    const parsedWidth = Number.parseInt(ui.width.value, 10);
    const parsedThickness = Number.parseInt(ui.thickness.value, 10);
    if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedThickness)) {
        return;
    }

    const width = normalizeWidth(parsedWidth);
    const maxThicknessForWidth = getThicknessLimitForWidth(width);
    const thickness = clampInt(parsedThickness, data.minThickness, maxThicknessForWidth, data.defaultThickness);
    const centerX = data.defaultCenter.x;
    const centerY = data.defaultCenter.y;
    const centerZ = data.defaultCenter.z;

    ui.width.value = String(width);
    ui.thickness.max = String(maxThicknessForWidth);
    ui.thickness.value = String(thickness);
    syncNumberStepperStates();

    const payload = {
        width: width,
        thickness: thickness,
        centerX: centerX,
        centerY: centerY,
        centerZ: centerZ,
    };

    clearError();

    activeRequestToken += 1;
    worker.postMessage({
        msg: "generate",
        requestId: activeRequestToken,
        payload: payload,
    });
}

function resetWorker() {
    if (worker) {
        worker.terminate();
    }

    worker = new Worker("work.js?" + WORKER_CACHE_KEY);
    worker.onmessage = handleWorkerMessage;
}

function handleWorkerMessage(event) {
    const message = event.data || {};
    if (message.requestId !== activeRequestToken) {
        return;
    }

    if (message.msg === "complete") {
        lastResult = message.data;
        completedPointKeys = new Set();
        drawablePointKeys = buildDrawablePointKeys(lastResult);
        renderResult(lastResult, { recenter: true });
        updateDownloadButtonState();
        return;
    }

    const workerError = message.error || "Unknown generation error";
    showError(workerError);
}

function renderResult(result, options) {
    drawPreview(result);
    if (options && options.recenter) {
        centerPreviewOnCircle(result);
    }
}

function drawPreview(result) {
    const zoom = getCurrentZoom();
    const layout = getPreviewLayout(result, zoom, getCurrentViewMode());
    const previewStyle = getPreviewStyle();
    const viewBounds = layout.viewBounds;
    const viewWidth = layout.viewWidth;
    const viewHeight = layout.viewHeight;
    const totalColumns = layout.totalColumns;
    const totalRows = layout.totalRows;
    const originX = layout.paddingCells * zoom;
    const originY = layout.paddingCells * zoom;
    const canvas = ui.canvas;
    const context = canvas.getContext("2d");

    canvas.width = Math.max(1, Math.ceil(totalColumns * zoom));
    canvas.height = Math.max(1, Math.ceil(totalRows * zoom));

    context.fillStyle = previewStyle.background;
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (zoom >= 10) {
        context.strokeStyle = previewStyle.gridLine;
        context.lineWidth = 1;

        for (let line = 0; line <= totalColumns; line += 1) {
            const offset = line * zoom + 0.5;

            context.beginPath();
            context.moveTo(offset, 0);
            context.lineTo(offset, canvas.height);
            context.stroke();
        }

        for (let line = 0; line <= totalRows; line += 1) {
            const offset = line * zoom + 0.5;
            context.beginPath();
            context.moveTo(0, offset);
            context.lineTo(canvas.width, offset);
            context.stroke();
        }
    }

    const centerOffset = getCenterOffset(result);
    const centerLineX = originX + (centerOffset - viewBounds.minColumn) * zoom + zoom / 2;
    const centerLineY = originY + (centerOffset - viewBounds.minRow) * zoom + zoom / 2;
    context.strokeStyle = previewStyle.axisLine;
    context.lineWidth = 2;

    if (centerLineX >= 0 && centerLineX <= canvas.width) {
        context.beginPath();
        context.moveTo(centerLineX, 0);
        context.lineTo(centerLineX, canvas.height);
        context.stroke();
    }

    if (centerLineY >= 0 && centerLineY <= canvas.height) {
        context.beginPath();
        context.moveTo(0, centerLineY);
        context.lineTo(canvas.width, centerLineY);
        context.stroke();
    }

    const selectedBlock = data.blocks.find(function(block) {
        return block.id === data.defaultBlockId;
    });
    const fallbackBlockColor = selectedBlock ? selectedBlock.color : "#9fa3a8";
    const blockColor = previewStyle.defaultBlock || fallbackBlockColor;
    const completedBlockColor = previewStyle.completedBlock;
    const inset = zoom >= 6 ? Math.max(1, Math.floor(zoom * 0.12)) : 0;
    const drawSize = Math.max(zoom - inset * 2, 0.25);
    const blockCornerRadius = zoom >= 6 ? Math.max(0.7, Math.min(3.2, drawSize * 0.18)) : 0;
    const shouldRoundBlocks = blockCornerRadius > 0.1;
    const shouldOutlineBlocks = shouldRoundBlocks && zoom >= 9 && drawSize >= 3;

    result.relativePoints.forEach(function(point) {
        if (!isPointVisibleInCurrentView(point.x, point.z)) {
            return;
        }

        const pointKey = serializePoint(point.x, point.z);
        const column = point.x + centerOffset;
        const row = centerOffset - point.z;
        const pixelX = originX + (column - viewBounds.minColumn) * zoom;
        const pixelY = originY + (row - viewBounds.minRow) * zoom;
        const blockLeft = pixelX + inset;
        const blockTop = pixelY + inset;
        const isCompletedPoint = completedPointKeys.has(pointKey);
        const shouldStyleBlockSurface = !isCompletedPoint;

        context.fillStyle = isCompletedPoint ? completedBlockColor : blockColor;
        if (shouldRoundBlocks) {
            fillRoundedRect(context, blockLeft, blockTop, drawSize, drawSize, blockCornerRadius);
            if (shouldStyleBlockSurface && drawSize >= 4) {
                paintBlockSurfaceOverlay(context, blockLeft, blockTop, drawSize, drawSize, blockCornerRadius, previewStyle);
            }
            if (shouldOutlineBlocks) {
                const strokeInset = 0.5;
                const strokeSize = drawSize - strokeInset * 2;
                if (strokeSize > 0.25) {
                    context.strokeStyle = previewStyle.cellOutline;
                    context.lineWidth = 1;
                    strokeRoundedRect(
                        context,
                        blockLeft + strokeInset,
                        blockTop + strokeInset,
                        strokeSize,
                        strokeSize,
                        Math.max(0, blockCornerRadius - strokeInset)
                    );
                }
            }
            return;
        }

        context.fillRect(blockLeft, blockTop, drawSize, drawSize);
        if (shouldStyleBlockSurface && drawSize >= 4) {
            paintBlockSurfaceOverlay(context, blockLeft, blockTop, drawSize, drawSize, 0, previewStyle);
        }
    });

    if (isMeasurementOverlayEnabled()) {
        drawMeasurementOverlay(context, result, layout, zoom);
    }
}

function isMeasurementOverlayEnabled() {
    return Boolean(ui.showMeasurements && ui.showMeasurements.checked);
}

function drawMeasurementOverlay(context, result, layout, zoom) {
    const overlayData = getMeasurementOverlayData(result);
    if (!overlayData || !overlayData.runs.length) {
        return;
    }

    const visibleRuns = getVisibleMeasurementRuns(overlayData.runs, overlayData.centerOffset, getCurrentViewMode());
    if (!visibleRuns.length) {
        return;
    }

    const overlayStyle = getMeasurementOverlayStyle();
    const originX = layout.paddingCells * zoom;
    const originY = layout.paddingCells * zoom;
    const viewBounds = layout.viewBounds;
    const centerEdge = overlayData.centerEdge;
    const fontSize = Math.max(10, Math.min(14, Math.round(zoom * 0.48)));
    const lineOffset = Math.max(4, zoom * 0.52);
    const lineOffsetStep = Math.max(3, zoom * 0.44);
    const labelGap = Math.max(9, fontSize * 0.95);
    const labelPadX = Math.max(3, Math.round(fontSize * 0.34));
    const labelPadY = Math.max(2, Math.round(fontSize * 0.2));
    const canvasMargin = 4;
    const placedLabelRects = [];
    const runs = visibleRuns.slice().sort(function(runA, runB) {
        return runB.length - runA.length;
    });

    context.save();
    context.font = "600 " + fontSize + "px Inter, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.strokeStyle = overlayStyle.lineColor;
    context.lineWidth = 1;
    context.lineJoin = "round";
    context.lineCap = "round";

    runs.forEach(function(run) {
        const text = String(run.length);
        const metrics = context.measureText(text);
        const textWidth = Math.max(1, metrics.width);
        const labelWidth = textWidth + labelPadX * 2;
        const labelHeight = fontSize + labelPadY * 2;
        const geometry = getRunCanvasGeometry(run, centerEdge, originX, originY, viewBounds, zoom);
        if (!geometry) {
            return;
        }

        let placement = null;

        for (let attempt = 0; attempt < MEASUREMENT_OVERLAY_MAX_ATTEMPTS; attempt += 1) {
            const offset = lineOffset + attempt * lineOffsetStep;
            const candidate = getRunPlacementCandidate(
                geometry,
                offset,
                labelGap,
                labelWidth,
                labelHeight,
                canvasMargin,
                context.canvas.width,
                context.canvas.height
            );
            if (!candidate) {
                continue;
            }

            const hasCollision = placedLabelRects.some(function(existingRect) {
                return rectanglesOverlap(existingRect, candidate.labelRect, 2);
            });
            if (hasCollision) {
                continue;
            }

            placement = candidate;
            break;
        }

        if (!placement) {
            return;
        }

        drawMeasurementBracket(context, geometry, placement.bracketOffset);
        context.fillStyle = overlayStyle.labelBackground;
        fillRoundedRect(
            context,
            placement.labelRect.left,
            placement.labelRect.top,
            labelWidth,
            labelHeight,
            4
        );
        context.fillStyle = overlayStyle.textColor;
        context.fillText(text, placement.labelX, placement.labelY);
        placedLabelRects.push(placement.labelRect);
    });

    context.restore();
}

function getMeasurementOverlayStyle() {
    const rootStyle = getComputedStyle(document.documentElement);
    const isLightTheme = normalizeTheme(document.documentElement.getAttribute("data-theme")) === LIGHT_THEME;

    return {
        lineColor: readCssColor(rootStyle, "--measure-line", isLightTheme ? "rgba(41, 95, 170, 0.56)" : "rgba(157, 188, 232, 0.64)"),
        textColor: readCssColor(rootStyle, "--measure-text", isLightTheme ? "#234f90" : "#dbe9ff"),
        labelBackground: readCssColor(rootStyle, "--measure-bg", isLightTheme ? "rgba(255, 255, 255, 0.92)" : "rgba(14, 22, 35, 0.85)"),
    };
}

function getPreviewStyle() {
    const rootStyle = getComputedStyle(document.documentElement);
    const isLightTheme = normalizeTheme(document.documentElement.getAttribute("data-theme")) === LIGHT_THEME;

    return {
        background: readCssColor(rootStyle, "--canvas-bg", isLightTheme ? "#e7eef7" : "#111722"),
        gridLine: readCssColor(rootStyle, "--canvas-grid", isLightTheme ? "#c8d9ec" : "#233145"),
        axisLine: readCssColor(rootStyle, "--canvas-axis", isLightTheme ? "#7f9fc5" : "#3f5f87"),
        defaultBlock: readCssColor(rootStyle, "--canvas-default-block", isLightTheme ? "#4d88e6" : "#5e9eff"),
        completedBlock: readCssColor(rootStyle, "--canvas-complete-block", isLightTheme ? "#2a9650" : "#39be65"),
        cellOutline: readCssColor(rootStyle, "--canvas-cell-outline", isLightTheme ? "rgba(17, 45, 76, 0.16)" : "rgba(229, 238, 252, 0.16)"),
        blockOverlayTop: readCssColor(rootStyle, "--canvas-block-overlay-top", "rgba(255, 255, 255, 0)"),
        blockOverlayMid: readCssColor(rootStyle, "--canvas-block-overlay-mid", "rgba(255, 255, 255, 0)"),
        blockOverlayBottom: readCssColor(rootStyle, "--canvas-block-overlay-bottom", "rgba(0, 0, 0, 0)"),
        blockHighlight: readCssColor(rootStyle, "--canvas-block-highlight", "rgba(255, 255, 255, 0)"),
    };
}

function paintBlockSurfaceOverlay(context, left, top, width, height, radius, previewStyle) {
    const gradient = context.createLinearGradient(0, top, 0, top + height);
    gradient.addColorStop(0, previewStyle.blockOverlayTop);
    gradient.addColorStop(0.45, previewStyle.blockOverlayMid);
    gradient.addColorStop(1, previewStyle.blockOverlayBottom);
    context.fillStyle = gradient;

    if (radius > 0.1) {
        fillRoundedRect(context, left, top, width, height, radius);
    } else {
        context.fillRect(left, top, width, height);
    }

    if (height >= 6) {
        const highlightInset = radius > 0.1 ? 1 : 0;
        const highlightWidth = width - highlightInset * 2;
        if (highlightWidth > 0.75) {
            context.fillStyle = previewStyle.blockHighlight;
            context.fillRect(left + highlightInset, top + highlightInset, highlightWidth, 1);
        }
    }
}

function readCssColor(rootStyle, variableName, fallback) {
    const value = rootStyle.getPropertyValue(variableName);
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    return fallback;
}

function getMeasurementOverlayData(result) {
    if (!result) {
        return null;
    }

    const cached = measurementOverlayCache.get(result);
    if (cached) {
        return cached;
    }

    const generated = buildMeasurementOverlayData(result);
    measurementOverlayCache.set(result, generated);
    return generated;
}

function buildMeasurementOverlayData(result) {
    const centerOffset = getCenterOffset(result);
    const cellData = buildCircleCellData(result, centerOffset);
    if (!cellData) {
        return {
            centerOffset: centerOffset,
            centerEdge: centerOffset + 0.5,
            runs: [],
        };
    }

    const exteriorData = floodFillExteriorCells(cellData);
    const horizontalEdges = new Map();
    const verticalEdges = new Map();

    cellData.cells.forEach(function(cell) {
        const column = cell.column;
        const row = cell.row;

        const northKey = serializePoint(column, row - 1);
        if (!cellData.cellKeys.has(northKey) && exteriorData.exteriorKeys.has(northKey)) {
            addHorizontalEdge(horizontalEdges, row, column);
        }

        const eastKey = serializePoint(column + 1, row);
        if (!cellData.cellKeys.has(eastKey) && exteriorData.exteriorKeys.has(eastKey)) {
            addVerticalEdge(verticalEdges, column + 1, row);
        }

        const southKey = serializePoint(column, row + 1);
        if (!cellData.cellKeys.has(southKey) && exteriorData.exteriorKeys.has(southKey)) {
            addHorizontalEdge(horizontalEdges, row + 1, column);
        }

        const westKey = serializePoint(column - 1, row);
        if (!cellData.cellKeys.has(westKey) && exteriorData.exteriorKeys.has(westKey)) {
            addVerticalEdge(verticalEdges, column, row);
        }
    });

    const runs = mergeMeasurementRuns(horizontalEdges, verticalEdges, centerOffset + 0.5);
    return {
        centerOffset: centerOffset,
        centerEdge: centerOffset + 0.5,
        runs: runs,
    };
}

function buildCircleCellData(result, centerOffset) {
    const cells = [];
    const cellKeys = new Set();
    let minColumn = Infinity;
    let maxColumn = -Infinity;
    let minRow = Infinity;
    let maxRow = -Infinity;

    result.relativePoints.forEach(function(point) {
        const column = toGridIndex(point.x + centerOffset);
        const row = toGridIndex(centerOffset - point.z);
        const key = serializePoint(column, row);
        if (cellKeys.has(key)) {
            return;
        }

        cellKeys.add(key);
        cells.push({
            column: column,
            row: row,
        });

        minColumn = Math.min(minColumn, column);
        maxColumn = Math.max(maxColumn, column);
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
    });

    if (!cells.length) {
        return null;
    }

    return {
        centerEdge: centerOffset + 0.5,
        cells: cells,
        cellKeys: cellKeys,
        minColumn: minColumn,
        maxColumn: maxColumn,
        minRow: minRow,
        maxRow: maxRow,
    };
}

function floodFillExteriorCells(cellData) {
    const minColumn = cellData.minColumn - 1;
    const maxColumn = cellData.maxColumn + 1;
    const minRow = cellData.minRow - 1;
    const maxRow = cellData.maxRow + 1;
    const startColumn = minColumn;
    const startRow = minRow;
    const startKey = serializePoint(startColumn, startRow);
    const exteriorKeys = new Set([startKey]);
    const queue = [{ column: startColumn, row: startRow }];
    let head = 0;

    while (head < queue.length) {
        const current = queue[head];
        head += 1;

        const neighbors = [
            { column: current.column, row: current.row - 1 },
            { column: current.column + 1, row: current.row },
            { column: current.column, row: current.row + 1 },
            { column: current.column - 1, row: current.row },
        ];

        neighbors.forEach(function(neighbor) {
            if (
                neighbor.column < minColumn ||
                neighbor.column > maxColumn ||
                neighbor.row < minRow ||
                neighbor.row > maxRow
            ) {
                return;
            }

            const neighborKey = serializePoint(neighbor.column, neighbor.row);
            if (cellData.cellKeys.has(neighborKey) || exteriorKeys.has(neighborKey)) {
                return;
            }

            exteriorKeys.add(neighborKey);
            queue.push(neighbor);
        });
    }

    return {
        exteriorKeys: exteriorKeys,
    };
}

function addHorizontalEdge(horizontalEdges, y, startX) {
    let bucket = horizontalEdges.get(y);
    if (!bucket) {
        bucket = new Set();
        horizontalEdges.set(y, bucket);
    }
    bucket.add(startX);
}

function addVerticalEdge(verticalEdges, x, startY) {
    let bucket = verticalEdges.get(x);
    if (!bucket) {
        bucket = new Set();
        verticalEdges.set(x, bucket);
    }
    bucket.add(startY);
}

function mergeMeasurementRuns(horizontalEdges, verticalEdges, centerEdge) {
    const runs = [];

    horizontalEdges.forEach(function(xStarts, y) {
        const sorted = Array.from(xStarts).sort(function(left, right) {
            return left - right;
        });
        appendContiguousRuns(sorted, function(start, end) {
            const sourceRun = {
                orientation: "horizontal",
                y: y,
                startX: start,
                endX: end + 1,
                length: end - start + 1,
            };
            const splitRuns = splitRunAtCenterAxis(sourceRun, centerEdge);
            splitRuns.forEach(function(splitRun) {
                if (splitRun.length > 0) {
                    runs.push(splitRun);
                }
            });
        });
    });

    verticalEdges.forEach(function(yStarts, x) {
        const sorted = Array.from(yStarts).sort(function(top, bottom) {
            return top - bottom;
        });
        appendContiguousRuns(sorted, function(start, end) {
            const sourceRun = {
                orientation: "vertical",
                x: x,
                startY: start,
                endY: end + 1,
                length: end - start + 1,
            };
            const splitRuns = splitRunAtCenterAxis(sourceRun, centerEdge);
            splitRuns.forEach(function(splitRun) {
                if (splitRun.length > 0) {
                    runs.push(splitRun);
                }
            });
        });
    });

    return runs;
}

function splitRunAtCenterAxis(run, centerEdge) {
    if (run.orientation === "horizontal") {
        return splitLinearRunByAxis(run.startX, run.endX, function(unitStart) {
            return getAxisSideBucket(unitStart + 0.5, centerEdge);
        }, function(startValue, endValue) {
            return {
                orientation: "horizontal",
                y: run.y,
                startX: startValue,
                endX: endValue,
                length: endValue - startValue,
            };
        });
    }

    if (run.orientation === "vertical") {
        return splitLinearRunByAxis(run.startY, run.endY, function(unitStart) {
            return getAxisSideBucket(unitStart + 0.5, centerEdge);
        }, function(startValue, endValue) {
            return {
                orientation: "vertical",
                x: run.x,
                startY: startValue,
                endY: endValue,
                length: endValue - startValue,
            };
        });
    }

    return [run];
}

function splitLinearRunByAxis(startValue, endValue, getBucket, createRun) {
    if (endValue <= startValue) {
        return [];
    }

    const splitRuns = [];
    let currentBucket = getBucket(startValue);
    let segmentStart = startValue;

    for (let unitStart = startValue + 1; unitStart < endValue; unitStart += 1) {
        const bucket = getBucket(unitStart);
        if (bucket === currentBucket) {
            continue;
        }

        splitRuns.push(createRun(segmentStart, unitStart));
        segmentStart = unitStart;
        currentBucket = bucket;
    }

    splitRuns.push(createRun(segmentStart, endValue));
    return splitRuns;
}

function getAxisSideBucket(value, axisValue) {
    const delta = value - axisValue;
    if (Math.abs(delta) < 0.000001) {
        return 0;
    }
    return delta < 0 ? -1 : 1;
}

function appendContiguousRuns(sortedValues, onRun) {
    if (!sortedValues.length) {
        return;
    }

    let runStart = sortedValues[0];
    let previous = sortedValues[0];

    for (let index = 1; index < sortedValues.length; index += 1) {
        const value = sortedValues[index];
        if (value === previous + 1) {
            previous = value;
            continue;
        }

        onRun(runStart, previous);
        runStart = value;
        previous = value;
    }

    onRun(runStart, previous);
}

function getVisibleMeasurementRuns(runs, centerOffset, mode) {
    if (mode === VIEW_MODE_FULL) {
        return mergeCardinalRunsForFullView(runs, centerOffset).filter(function(run) {
            return run.length > 1;
        });
    }

    return runs.filter(function(run) {
        if (run.length <= 1) {
            return false;
        }
        const referencePoint = getRunReferencePoint(run, centerOffset);
        return isPointVisibleInView(referencePoint.x, referencePoint.z, mode);
    });
}

function mergeCardinalRunsForFullView(runs, centerOffset) {
    if (!runs.length) {
        return [];
    }

    const centerEdge = centerOffset + 0.5;
    const mergedRuns = [];
    const consumedRuns = new Set();
    const topY = getExtremeRunCoordinate(runs, "horizontal", "y", true);
    const bottomY = getExtremeRunCoordinate(runs, "horizontal", "y", false);
    const leftX = getExtremeRunCoordinate(runs, "vertical", "x", true);
    const rightX = getExtremeRunCoordinate(runs, "vertical", "x", false);

    mergeCardinalLineRuns(runs, consumedRuns, mergedRuns, "horizontal", "y", topY, centerEdge);
    if (bottomY !== null && bottomY !== topY) {
        mergeCardinalLineRuns(runs, consumedRuns, mergedRuns, "horizontal", "y", bottomY, centerEdge);
    }

    mergeCardinalLineRuns(runs, consumedRuns, mergedRuns, "vertical", "x", leftX, centerEdge);
    if (rightX !== null && rightX !== leftX) {
        mergeCardinalLineRuns(runs, consumedRuns, mergedRuns, "vertical", "x", rightX, centerEdge);
    }

    if (!consumedRuns.size) {
        return runs;
    }

    const remainingRuns = [];
    runs.forEach(function(run) {
        if (!consumedRuns.has(run)) {
            remainingRuns.push(run);
        }
    });

    return remainingRuns.concat(mergedRuns);
}

function getExtremeRunCoordinate(runs, orientation, coordinateKey, chooseMinimum) {
    let extreme = null;
    runs.forEach(function(run) {
        if (run.orientation !== orientation) {
            return;
        }

        if (
            extreme === null ||
            (chooseMinimum && run[coordinateKey] < extreme) ||
            (!chooseMinimum && run[coordinateKey] > extreme)
        ) {
            extreme = run[coordinateKey];
        }
    });
    return extreme;
}

function mergeCardinalLineRuns(runs, consumedRuns, mergedRuns, orientation, coordinateKey, coordinateValue, centerEdge) {
    if (coordinateValue === null) {
        return;
    }

    const lineRuns = runs.filter(function(run) {
        return (
            run.orientation === orientation &&
            run[coordinateKey] === coordinateValue &&
            !consumedRuns.has(run)
        );
    });

    const mergeResult = getAxisConnectedMerge(lineRuns, orientation, centerEdge);
    if (!mergeResult) {
        return;
    }

    mergeResult.sourceRuns.forEach(function(sourceRun) {
        consumedRuns.add(sourceRun);
    });
    mergedRuns.push(mergeResult.mergedRun);
}

function getAxisConnectedMerge(lineRuns, orientation, centerEdge) {
    if (lineRuns.length < 2) {
        return null;
    }

    const isHorizontal = orientation === "horizontal";
    const startKey = isHorizontal ? "startX" : "startY";
    const endKey = isHorizontal ? "endX" : "endY";
    const sortedRuns = lineRuns.slice().sort(function(runA, runB) {
        return runA[startKey] - runB[startKey];
    });
    const epsilon = 0.000001;
    let anchorIndex = -1;

    for (let index = 0; index < sortedRuns.length; index += 1) {
        const run = sortedRuns[index];
        if (run[startKey] <= centerEdge + epsilon && run[endKey] >= centerEdge - epsilon) {
            anchorIndex = index;
            break;
        }
    }

    if (anchorIndex < 0) {
        return null;
    }

    let leftIndex = anchorIndex;
    let rightIndex = anchorIndex;

    while (leftIndex > 0) {
        const previousRun = sortedRuns[leftIndex - 1];
        const currentRun = sortedRuns[leftIndex];
        if (Math.abs(previousRun[endKey] - currentRun[startKey]) >= epsilon) {
            break;
        }
        leftIndex -= 1;
    }

    while (rightIndex < sortedRuns.length - 1) {
        const currentRun = sortedRuns[rightIndex];
        const nextRun = sortedRuns[rightIndex + 1];
        if (Math.abs(currentRun[endKey] - nextRun[startKey]) >= epsilon) {
            break;
        }
        rightIndex += 1;
    }

    const sourceRuns = sortedRuns.slice(leftIndex, rightIndex + 1);
    if (sourceRuns.length < 2) {
        return null;
    }

    if (isHorizontal) {
        const mergedStartX = sourceRuns[0].startX;
        const mergedEndX = sourceRuns[sourceRuns.length - 1].endX;
        return {
            sourceRuns: sourceRuns,
            mergedRun: {
                orientation: "horizontal",
                y: sourceRuns[0].y,
                startX: mergedStartX,
                endX: mergedEndX,
                length: mergedEndX - mergedStartX,
            },
        };
    }

    const mergedStartY = sourceRuns[0].startY;
    const mergedEndY = sourceRuns[sourceRuns.length - 1].endY;
    return {
        sourceRuns: sourceRuns,
        mergedRun: {
            orientation: "vertical",
            x: sourceRuns[0].x,
            startY: mergedStartY,
            endY: mergedEndY,
            length: mergedEndY - mergedStartY,
        },
    };
}

function getRunReferencePoint(run, centerOffset) {
    const centerEdge = centerOffset + 0.5;

    if (run.orientation === "horizontal") {
        const insideRow = run.y <= centerEdge ? run.y : run.y - 1;
        const middleColumn = (run.startX + run.endX) / 2 - 0.5;
        return {
            x: middleColumn - centerOffset,
            z: centerOffset - insideRow,
        };
    }

    const insideColumn = run.x <= centerEdge ? run.x : run.x - 1;
    const middleRow = (run.startY + run.endY) / 2 - 0.5;
    return {
        x: insideColumn - centerOffset,
        z: centerOffset - middleRow,
    };
}

function getRunCanvasGeometry(run, centerEdge, originX, originY, viewBounds, zoom) {
    if (run.orientation === "horizontal") {
        const baseY = originY + (run.y - viewBounds.minRow) * zoom;
        const startX = originX + (run.startX - viewBounds.minColumn) * zoom;
        const endX = originX + (run.endX - viewBounds.minColumn) * zoom;
        return {
            orientation: "horizontal",
            startX: startX,
            endX: endX,
            startY: baseY,
            endY: baseY,
            normalX: 0,
            normalY: run.y <= centerEdge ? -1 : 1,
        };
    }

    if (run.orientation === "vertical") {
        const baseX = originX + (run.x - viewBounds.minColumn) * zoom;
        const startY = originY + (run.startY - viewBounds.minRow) * zoom;
        const endY = originY + (run.endY - viewBounds.minRow) * zoom;
        return {
            orientation: "vertical",
            startX: baseX,
            endX: baseX,
            startY: startY,
            endY: endY,
            normalX: run.x <= centerEdge ? -1 : 1,
            normalY: 0,
        };
    }

    return null;
}

function getRunPlacementCandidate(
    geometry,
    bracketOffset,
    labelGap,
    labelWidth,
    labelHeight,
    canvasMargin,
    canvasWidth,
    canvasHeight
) {
    let labelX = 0;
    let labelY = 0;

    if (geometry.orientation === "horizontal") {
        const midpointX = (geometry.startX + geometry.endX) / 2;
        labelX = midpointX;
        labelY = geometry.startY + geometry.normalY * (bracketOffset + labelGap);
    } else {
        const midpointY = (geometry.startY + geometry.endY) / 2;
        labelX = geometry.startX + geometry.normalX * (bracketOffset + labelGap);
        labelY = midpointY;
    }

    const halfWidth = labelWidth / 2;
    const halfHeight = labelHeight / 2;
    const minLabelX = canvasMargin + halfWidth;
    const maxLabelX = canvasWidth - canvasMargin - halfWidth;
    const minLabelY = canvasMargin + halfHeight;
    const maxLabelY = canvasHeight - canvasMargin - halfHeight;
    labelX = clampNumber(labelX, minLabelX, maxLabelX, labelX);
    labelY = clampNumber(labelY, minLabelY, maxLabelY, labelY);

    return {
        bracketOffset: bracketOffset,
        labelX: labelX,
        labelY: labelY,
        labelRect: {
            left: labelX - halfWidth,
            top: labelY - halfHeight,
            right: labelX + halfWidth,
            bottom: labelY + halfHeight,
        },
    };
}

function drawMeasurementBracket(context, geometry, bracketOffset) {
    if (geometry.orientation === "horizontal") {
        const edgeY = alignCanvasLine(geometry.startY);
        const bracketY = alignCanvasLine(geometry.startY + geometry.normalY * bracketOffset);
        const startX = alignCanvasLine(Math.min(geometry.startX, geometry.endX));
        const endX = alignCanvasLine(Math.max(geometry.startX, geometry.endX));

        context.beginPath();
        context.moveTo(startX, edgeY);
        context.lineTo(startX, bracketY);
        context.moveTo(endX, edgeY);
        context.lineTo(endX, bracketY);
        context.moveTo(startX, bracketY);
        context.lineTo(endX, bracketY);
        context.stroke();
        return;
    }

    const edgeX = alignCanvasLine(geometry.startX);
    const bracketX = alignCanvasLine(geometry.startX + geometry.normalX * bracketOffset);
    const startY = alignCanvasLine(Math.min(geometry.startY, geometry.endY));
    const endY = alignCanvasLine(Math.max(geometry.startY, geometry.endY));

    context.beginPath();
    context.moveTo(edgeX, startY);
    context.lineTo(bracketX, startY);
    context.moveTo(edgeX, endY);
    context.lineTo(bracketX, endY);
    context.moveTo(bracketX, startY);
    context.lineTo(bracketX, endY);
    context.stroke();
}

function fillRoundedRect(context, left, top, width, height, radius) {
    traceRoundedRectPath(context, left, top, width, height, radius);
    context.fill();
}

function strokeRoundedRect(context, left, top, width, height, radius) {
    traceRoundedRectPath(context, left, top, width, height, radius);
    context.stroke();
}

function traceRoundedRectPath(context, left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    const cornerRadius = Math.max(0, Math.min(radius, width / 2, height / 2));

    context.beginPath();
    context.moveTo(left + cornerRadius, top);
    context.lineTo(right - cornerRadius, top);
    context.quadraticCurveTo(right, top, right, top + cornerRadius);
    context.lineTo(right, bottom - cornerRadius);
    context.quadraticCurveTo(right, bottom, right - cornerRadius, bottom);
    context.lineTo(left + cornerRadius, bottom);
    context.quadraticCurveTo(left, bottom, left, bottom - cornerRadius);
    context.lineTo(left, top + cornerRadius);
    context.quadraticCurveTo(left, top, left + cornerRadius, top);
    context.closePath();
}

function rectanglesOverlap(rectA, rectB, padding) {
    const safePadding = Number.isFinite(padding) ? padding : 0;
    if (rectA.right + safePadding < rectB.left) {
        return false;
    }
    if (rectB.right + safePadding < rectA.left) {
        return false;
    }
    if (rectA.bottom + safePadding < rectB.top) {
        return false;
    }
    if (rectB.bottom + safePadding < rectA.top) {
        return false;
    }
    return true;
}

function alignCanvasLine(value) {
    return Math.round(value) + 0.5;
}

function toGridIndex(value) {
    return Math.round(value);
}

function handlePreviewWheel(event) {
    if (!lastResult) {
        return;
    }

    event.preventDefault();

    const zoomBeforeWheel = getCurrentZoom();
    const nextZoom = clampNumber(
        zoomBeforeWheel * Math.exp(-event.deltaY * data.zoom.wheelSensitivity),
        data.zoom.min,
        data.zoom.max,
        zoomBeforeWheel
    );

    if (Math.abs(nextZoom - zoomBeforeWheel) < 0.001) {
        return;
    }

    const shellRect = ui.previewShell.getBoundingClientRect();
    const pointerOffsetX = event.clientX - shellRect.left;
    const pointerOffsetY = event.clientY - shellRect.top;
    const canvasLeft = ui.canvas.offsetLeft;
    const canvasTop = ui.canvas.offsetTop;
    const canvasPointerX = ui.previewShell.scrollLeft + pointerOffsetX - canvasLeft;
    const canvasPointerY = ui.previewShell.scrollTop + pointerOffsetY - canvasTop;
    const viewMode = getCurrentViewMode();
    const beforeLayout = getPreviewLayout(lastResult, zoomBeforeWheel, viewMode);
    const worldColumn = (canvasPointerX / zoomBeforeWheel) - beforeLayout.paddingCells + beforeLayout.viewBounds.minColumn;
    const worldRow = (canvasPointerY / zoomBeforeWheel) - beforeLayout.paddingCells + beforeLayout.viewBounds.minRow;

    currentZoom = nextZoom;
    syncZoomSliderToCurrent();
    updateZoomLabel();
    drawPreview(lastResult);

    const afterLayout = getPreviewLayout(lastResult, nextZoom, viewMode);
    const newCanvasLeft = ui.canvas.offsetLeft;
    const newCanvasTop = ui.canvas.offsetTop;
    const nextGridX = worldColumn - afterLayout.viewBounds.minColumn + afterLayout.paddingCells;
    const nextGridY = worldRow - afterLayout.viewBounds.minRow + afterLayout.paddingCells;
    const nextPointerContentX = newCanvasLeft + nextGridX * nextZoom;
    const nextPointerContentY = newCanvasTop + nextGridY * nextZoom;

    ui.previewShell.scrollLeft = nextPointerContentX - pointerOffsetX;
    ui.previewShell.scrollTop = nextPointerContentY - pointerOffsetY;
}

function handlePreviewDragStart(event) {
    if (event.button !== 0) {
        return;
    }

    isPreviewDragging = true;
    didPreviewDragMove = false;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartScrollLeft = ui.previewShell.scrollLeft;
    dragStartScrollTop = ui.previewShell.scrollTop;
    ui.previewShell.classList.add("is-dragging");
}

function handlePreviewDragMove(event) {
    if (!isPreviewDragging) {
        return;
    }

    const deltaX = event.clientX - dragStartX;
    const deltaY = event.clientY - dragStartY;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        didPreviewDragMove = true;
    }

    ui.previewShell.scrollLeft = dragStartScrollLeft - deltaX;
    ui.previewShell.scrollTop = dragStartScrollTop - deltaY;
    event.preventDefault();
}

function handlePreviewDragEnd() {
    if (!isPreviewDragging) {
        return;
    }

    isPreviewDragging = false;
    ui.previewShell.classList.remove("is-dragging");
    if (didPreviewDragMove) {
        ignoreCanvasClickUntil = Date.now() + 180;
    }
}

function handleCanvasClick(event) {
    if (!lastResult || Date.now() < ignoreCanvasClickUntil) {
        return;
    }

    const zoom = getCurrentZoom();
    const layout = getPreviewLayout(lastResult, zoom, getCurrentViewMode());
    const viewBounds = layout.viewBounds;
    const originX = layout.paddingCells * zoom;
    const originY = layout.paddingCells * zoom;
    const canvasRect = ui.canvas.getBoundingClientRect();
    const canvasX = event.clientX - canvasRect.left;
    const canvasY = event.clientY - canvasRect.top;
    const column = Math.floor((canvasX - originX) / zoom) + viewBounds.minColumn;
    const row = Math.floor((canvasY - originY) / zoom) + viewBounds.minRow;

    const resultWidth = getResultWidth(lastResult);
    if (
        column < viewBounds.minColumn ||
        column >= viewBounds.maxColumn ||
        row < viewBounds.minRow ||
        row >= viewBounds.maxRow
    ) {
        return;
    }

    if (column < 0 || row < 0 || column >= resultWidth || row >= resultWidth) {
        return;
    }

    const centerOffset = getCenterOffset(lastResult);
    const pointX = column - centerOffset;
    const pointZ = centerOffset - row;
    if (!isPointVisibleInCurrentView(pointX, pointZ)) {
        return;
    }

    const pointKey = serializePoint(pointX, pointZ);

    if (!drawablePointKeys.has(pointKey)) {
        return;
    }

    if (completedPointKeys.has(pointKey)) {
        completedPointKeys.delete(pointKey);
    } else {
        completedPointKeys.add(pointKey);
    }

    drawPreview(lastResult);
}

function buildDrawablePointKeys(result) {
    const pointKeys = new Set();

    result.relativePoints.forEach(function(point) {
        pointKeys.add(serializePoint(point.x, point.z));
    });

    return pointKeys;
}

function serializePoint(x, z) {
    return x + "," + z;
}

function getCurrentViewMode() {
    const mode = ui.viewMode ? ui.viewMode.value : VIEW_MODE_FULL;
    if (
        mode === VIEW_MODE_NE ||
        mode === VIEW_MODE_NW ||
        mode === VIEW_MODE_SE ||
        mode === VIEW_MODE_SW
    ) {
        return mode;
    }
    return VIEW_MODE_FULL;
}

function isPointVisibleInCurrentView(pointX, pointZ) {
    return isPointVisibleInView(pointX, pointZ, getCurrentViewMode());
}

function isPointVisibleInView(pointX, pointZ, mode) {
    if (mode === VIEW_MODE_FULL) {
        return true;
    }
    if (mode === VIEW_MODE_NE) {
        return pointX >= 0 && pointZ >= 0;
    }
    if (mode === VIEW_MODE_NW) {
        return pointX <= 0 && pointZ >= 0;
    }
    if (mode === VIEW_MODE_SE) {
        return pointX >= 0 && pointZ <= 0;
    }
    return pointX <= 0 && pointZ <= 0;
}

function getViewBounds(result, mode) {
    const width = getResultWidth(result);
    const centerOffset = getCenterOffset(result);
    const lowerHalfMaxColumn = Math.floor(centerOffset) + 1;
    const upperHalfMinColumn = Math.ceil(centerOffset);
    const upperHalfMinRow = Math.ceil(centerOffset);
    const lowerHalfMaxRow = Math.floor(centerOffset) + 1;

    if (mode === VIEW_MODE_NE) {
        return { minColumn: upperHalfMinColumn, maxColumn: width, minRow: 0, maxRow: Math.min(width, lowerHalfMaxRow) };
    }
    if (mode === VIEW_MODE_NW) {
        return { minColumn: 0, maxColumn: Math.min(width, lowerHalfMaxColumn), minRow: 0, maxRow: Math.min(width, lowerHalfMaxRow) };
    }
    if (mode === VIEW_MODE_SE) {
        return { minColumn: upperHalfMinColumn, maxColumn: width, minRow: upperHalfMinRow, maxRow: width };
    }
    if (mode === VIEW_MODE_SW) {
        return { minColumn: 0, maxColumn: Math.min(width, lowerHalfMaxColumn), minRow: upperHalfMinRow, maxRow: width };
    }

    return { minColumn: 0, maxColumn: width, minRow: 0, maxRow: width };
}

function getPreviewLayout(result, zoom, mode) {
    const viewBounds = getViewBounds(result, mode);
    const viewWidth = Math.max(1, viewBounds.maxColumn - viewBounds.minColumn);
    const viewHeight = Math.max(1, viewBounds.maxRow - viewBounds.minRow);
    const paddingCells = getCanvasPaddingCells(viewWidth, viewHeight, zoom);
    const totalColumns = viewWidth + paddingCells * 2;
    const totalRows = viewHeight + paddingCells * 2;

    return {
        viewBounds: viewBounds,
        viewWidth: viewWidth,
        viewHeight: viewHeight,
        paddingCells: paddingCells,
        totalColumns: totalColumns,
        totalRows: totalRows,
    };
}

function centerPreviewOnCircle(result) {
    if (!ui.previewShell || !ui.canvas) {
        return;
    }

    const zoom = getCurrentZoom();
    const layout = getPreviewLayout(result, zoom, getCurrentViewMode());
    const centerOffset = getCenterOffset(result);
    const centerGridX = layout.paddingCells + (centerOffset - layout.viewBounds.minColumn) + 0.5;
    const centerGridY = layout.paddingCells + (centerOffset - layout.viewBounds.minRow) + 0.5;
    const targetScrollLeft = centerGridX * zoom - ui.previewShell.clientWidth / 2;
    const targetScrollTop = centerGridY * zoom - ui.previewShell.clientHeight / 2;
    const maxScrollLeft = Math.max(0, ui.canvas.width - ui.previewShell.clientWidth);
    const maxScrollTop = Math.max(0, ui.canvas.height - ui.previewShell.clientHeight);

    ui.previewShell.scrollLeft = clampNumber(targetScrollLeft, 0, maxScrollLeft, 0);
    ui.previewShell.scrollTop = clampNumber(targetScrollTop, 0, maxScrollTop, 0);
}

function getCanvasPaddingCells(viewWidth, viewHeight, zoom) {
    const safeZoom = Math.max(0.001, zoom);
    const dominantCells = Math.max(viewWidth, viewHeight);
    const dominantPixels = dominantCells * safeZoom;
    const targetPaddingPixels = Math.max(
        PREVIEW_PADDING_MIN_PX,
        Math.min(PREVIEW_PADDING_MAX_PX, dominantPixels * PREVIEW_PADDING_RATIO)
    );

    let paddingCells = Math.max(PREVIEW_PADDING_MIN_CELLS, Math.ceil(targetPaddingPixels / safeZoom));
    const shellWidth = ui.previewShell ? ui.previewShell.clientWidth : 0;
    const shellHeight = ui.previewShell ? ui.previewShell.clientHeight : 0;
    const requiredTotalColumns = Math.ceil((shellWidth + PREVIEW_VIEWPORT_BUFFER_PX * 2) / safeZoom);
    const requiredTotalRows = Math.ceil((shellHeight + PREVIEW_VIEWPORT_BUFFER_PX * 2) / safeZoom);
    const minPaddingByViewportWidth = Math.max(0, Math.ceil((requiredTotalColumns - viewWidth) / 2));
    const minPaddingByViewportHeight = Math.max(0, Math.ceil((requiredTotalRows - viewHeight) / 2));

    paddingCells = Math.max(
        paddingCells,
        minPaddingByViewportWidth,
        minPaddingByViewportHeight
    );

    const maxCellsPerSide = Math.floor(MAX_CANVAS_SIDE_PX / safeZoom);
    const maxPaddingByWidth = Math.floor((maxCellsPerSide - viewWidth) / 2);
    const maxPaddingByHeight = Math.floor((maxCellsPerSide - viewHeight) / 2);
    const maxPaddingCells = Math.max(0, Math.min(maxPaddingByWidth, maxPaddingByHeight));

    paddingCells = Math.min(paddingCells, maxPaddingCells);
    return Math.max(0, paddingCells);
}

function getResultWidth(result) {
    const parsedWidth = Number.parseInt(result.width, 10);
    if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
        return parsedWidth;
    }

    const parsedDiameter = Number.parseInt(result.diameter, 10);
    if (Number.isFinite(parsedDiameter) && parsedDiameter > 0) {
        return parsedDiameter;
    }

    return data.defaultWidth;
}

function getCenterOffset(result) {
    const parsedCenterOffset = Number.parseFloat(result.centerOffset);
    if (Number.isFinite(parsedCenterOffset)) {
        return parsedCenterOffset;
    }

    const parsedRadius = Number.parseFloat(result.radius);
    if (Number.isFinite(parsedRadius)) {
        return parsedRadius;
    }

    return (getResultWidth(result) - 1) / 2;
}

function getResultThickness(result) {
    const parsedThickness = Number.parseInt(result.thickness, 10);
    if (Number.isFinite(parsedThickness) && parsedThickness > 0) {
        return parsedThickness;
    }

    const parsedInputThickness = Number.parseInt(ui.thickness ? ui.thickness.value : data.defaultThickness, 10);
    if (Number.isFinite(parsedInputThickness) && parsedInputThickness > 0) {
        return parsedInputThickness;
    }

    return data.defaultThickness;
}

function updateDownloadButtonState() {
    if (!ui.downloadImage) {
        return;
    }

    ui.downloadImage.disabled = !lastResult;
}

function handleDownloadImageClick() {
    if (!lastResult || !ui.canvas) {
        return;
    }

    const exportCanvas = buildDownloadCanvas(lastResult);
    if (!exportCanvas) {
        showError("Unable to export circle image.");
        return;
    }

    try {
        const downloadLink = document.createElement("a");
        downloadLink.download = buildDownloadFileName(lastResult);
        downloadLink.href = exportCanvas.toDataURL("image/png");
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
    } catch (_error) {
        showError("Unable to export circle image.");
    }
}

function buildDownloadCanvas(result) {
    if (!ui.canvas) {
        return null;
    }

    const sourceBounds = getDownloadSourceBounds(result);
    const sourceWidth = Math.max(1, sourceBounds.right - sourceBounds.left);
    const sourceHeight = Math.max(1, sourceBounds.bottom - sourceBounds.top);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = sourceWidth;
    exportCanvas.height = sourceHeight;

    const context = exportCanvas.getContext("2d");
    if (!context) {
        return null;
    }

    context.imageSmoothingEnabled = false;
    context.drawImage(
        ui.canvas,
        sourceBounds.left,
        sourceBounds.top,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
    );

    return exportCanvas;
}

function getDownloadSourceBounds(result) {
    const zoom = getCurrentZoom();
    const layout = getPreviewLayout(result, zoom, getCurrentViewMode());
    const baseBounds = {
        left: Math.max(0, Math.floor(layout.paddingCells * zoom)),
        top: Math.max(0, Math.floor(layout.paddingCells * zoom)),
        right: Math.min(ui.canvas.width, Math.ceil((layout.paddingCells + layout.viewWidth) * zoom)),
        bottom: Math.min(ui.canvas.height, Math.ceil((layout.paddingCells + layout.viewHeight) * zoom)),
    };
    const measurementBounds = getMeasurementOverlayBounds(result, layout, zoom);
    const mergedBounds = mergeBounds(baseBounds, measurementBounds);
    const exportPadding = 2;

    return clampBoundsToCanvas({
        left: Math.floor(mergedBounds.left - exportPadding),
        top: Math.floor(mergedBounds.top - exportPadding),
        right: Math.ceil(mergedBounds.right + exportPadding),
        bottom: Math.ceil(mergedBounds.bottom + exportPadding),
    });
}

function getMeasurementOverlayBounds(result, layout, zoom) {
    if (!isMeasurementOverlayEnabled()) {
        return null;
    }

    const overlayData = getMeasurementOverlayData(result);
    if (!overlayData || !overlayData.runs.length) {
        return null;
    }

    const visibleRuns = getVisibleMeasurementRuns(overlayData.runs, overlayData.centerOffset, getCurrentViewMode());
    if (!visibleRuns.length) {
        return null;
    }

    const originX = layout.paddingCells * zoom;
    const originY = layout.paddingCells * zoom;
    const viewBounds = layout.viewBounds;
    const centerEdge = overlayData.centerEdge;
    const fontSize = Math.max(10, Math.min(14, Math.round(zoom * 0.48)));
    const lineOffset = Math.max(4, zoom * 0.52);
    const lineOffsetStep = Math.max(3, zoom * 0.44);
    const labelGap = Math.max(9, fontSize * 0.95);
    const labelPadX = Math.max(3, Math.round(fontSize * 0.34));
    const labelPadY = Math.max(2, Math.round(fontSize * 0.2));
    const canvasMargin = 4;
    const placedLabelRects = [];
    const runs = visibleRuns.slice().sort(function(runA, runB) {
        return runB.length - runA.length;
    });
    const measurementContext = getMeasurementTextContext();
    if (!measurementContext) {
        return null;
    }

    measurementContext.font = "600 " + fontSize + "px Inter, sans-serif";
    let bounds = null;

    runs.forEach(function(run) {
        const text = String(run.length);
        const metrics = measurementContext.measureText(text);
        const textWidth = Math.max(1, metrics.width);
        const labelWidth = textWidth + labelPadX * 2;
        const labelHeight = fontSize + labelPadY * 2;
        const geometry = getRunCanvasGeometry(run, centerEdge, originX, originY, viewBounds, zoom);
        if (!geometry) {
            return;
        }

        let placement = null;

        for (let attempt = 0; attempt < MEASUREMENT_OVERLAY_MAX_ATTEMPTS; attempt += 1) {
            const offset = lineOffset + attempt * lineOffsetStep;
            const candidate = getRunPlacementCandidate(
                geometry,
                offset,
                labelGap,
                labelWidth,
                labelHeight,
                canvasMargin,
                ui.canvas.width,
                ui.canvas.height
            );
            if (!candidate) {
                continue;
            }

            const hasCollision = placedLabelRects.some(function(existingRect) {
                return rectanglesOverlap(existingRect, candidate.labelRect, 2);
            });
            if (hasCollision) {
                continue;
            }

            placement = candidate;
            break;
        }

        if (!placement) {
            return;
        }

        const bracketBounds = getMeasurementBracketBounds(geometry, placement.bracketOffset);
        bounds = mergeBounds(bounds, bracketBounds);
        bounds = mergeBounds(bounds, placement.labelRect);
        placedLabelRects.push(placement.labelRect);
    });

    return bounds;
}

function getMeasurementBracketBounds(geometry, bracketOffset) {
    if (geometry.orientation === "horizontal") {
        const edgeY = alignCanvasLine(geometry.startY);
        const bracketY = alignCanvasLine(geometry.startY + geometry.normalY * bracketOffset);
        const startX = alignCanvasLine(Math.min(geometry.startX, geometry.endX));
        const endX = alignCanvasLine(Math.max(geometry.startX, geometry.endX));
        return {
            left: Math.min(startX, endX) - 1,
            top: Math.min(edgeY, bracketY) - 1,
            right: Math.max(startX, endX) + 1,
            bottom: Math.max(edgeY, bracketY) + 1,
        };
    }

    const edgeX = alignCanvasLine(geometry.startX);
    const bracketX = alignCanvasLine(geometry.startX + geometry.normalX * bracketOffset);
    const startY = alignCanvasLine(Math.min(geometry.startY, geometry.endY));
    const endY = alignCanvasLine(Math.max(geometry.startY, geometry.endY));
    return {
        left: Math.min(edgeX, bracketX) - 1,
        top: Math.min(startY, endY) - 1,
        right: Math.max(edgeX, bracketX) + 1,
        bottom: Math.max(startY, endY) + 1,
    };
}

function getMeasurementTextContext() {
    const canvas = document.createElement("canvas");
    return canvas.getContext("2d");
}

function mergeBounds(primary, secondary) {
    if (!primary) {
        return secondary ? {
            left: secondary.left,
            top: secondary.top,
            right: secondary.right,
            bottom: secondary.bottom,
        } : null;
    }

    if (!secondary) {
        return {
            left: primary.left,
            top: primary.top,
            right: primary.right,
            bottom: primary.bottom,
        };
    }

    return {
        left: Math.min(primary.left, secondary.left),
        top: Math.min(primary.top, secondary.top),
        right: Math.max(primary.right, secondary.right),
        bottom: Math.max(primary.bottom, secondary.bottom),
    };
}

function clampBoundsToCanvas(bounds) {
    const safeBounds = bounds || { left: 0, top: 0, right: 1, bottom: 1 };
    const left = Math.max(0, Math.min(ui.canvas.width - 1, safeBounds.left));
    const top = Math.max(0, Math.min(ui.canvas.height - 1, safeBounds.top));
    const right = Math.max(left + 1, Math.min(ui.canvas.width, safeBounds.right));
    const bottom = Math.max(top + 1, Math.min(ui.canvas.height, safeBounds.bottom));

    return {
        left: left,
        top: top,
        right: right,
        bottom: bottom,
    };
}

function buildDownloadFileName(result) {
    const width = getResultWidth(result);
    const thickness = getResultThickness(result);
    return "circle-w" + width + "-t" + thickness + ".png";
}

function showError(message) {
    ui.errorMessage.textContent = message;
    ui.error.hidden = false;
}

function clearError() {
    ui.error.hidden = true;
    ui.errorMessage.textContent = "";
}

function updateZoomLabel() {
    if (!ui.zoomValue) {
        return;
    }

    const zoom = getCurrentZoom();
    if (zoom >= 10) {
        ui.zoomValue.textContent = Math.round(zoom) + "x";
        return;
    }
    if (zoom >= 1) {
        ui.zoomValue.textContent = zoom.toFixed(1) + "x";
        return;
    }
    ui.zoomValue.textContent = zoom.toFixed(2) + "x";
}

function getCurrentZoom() {
    return clampNumber(currentZoom, data.zoom.min, data.zoom.max, data.zoom.default);
}

function syncZoomSliderToCurrent() {
    if (!ui.zoom) {
        return;
    }

    ui.zoom.value = String(Math.round(zoomToSliderValue(getCurrentZoom())));
}

function sliderValueToZoom(sliderValue) {
    const normalizedSlider = clampNumber(sliderValue, data.zoom.sliderMin, data.zoom.sliderMax, data.zoom.sliderMin);
    const sliderRange = data.zoom.sliderMax - data.zoom.sliderMin;
    if (sliderRange <= 0) {
        return data.zoom.default;
    }

    const ratio = (normalizedSlider - data.zoom.sliderMin) / sliderRange;
    const minLog = Math.log(data.zoom.min);
    const maxLog = Math.log(data.zoom.max);
    return Math.exp(minLog + (maxLog - minLog) * ratio);
}

function zoomToSliderValue(zoomValue) {
    const normalizedZoom = clampNumber(zoomValue, data.zoom.min, data.zoom.max, data.zoom.default);
    const minLog = Math.log(data.zoom.min);
    const maxLog = Math.log(data.zoom.max);
    if (Math.abs(maxLog - minLog) < 0.0001) {
        return data.zoom.sliderMin;
    }

    const ratio = (Math.log(normalizedZoom) - minLog) / (maxLog - minLog);
    return data.zoom.sliderMin + (data.zoom.sliderMax - data.zoom.sliderMin) * ratio;
}

function clampInt(value, minimum, maximum, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeWidth(value) {
    return clampInt(value, data.minWidth, data.maxWidth, data.defaultWidth);
}

function getThicknessLimitForWidth(width) {
    const widthBasedLimit = Math.max(data.minThickness, Math.ceil((width - 1) / 2));
    return Math.min(data.maxThickness, widthBasedLimit);
}

function clampNumber(value, minimum, maximum, fallback) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeTheme(theme) {
    return theme === LIGHT_THEME ? LIGHT_THEME : DARK_THEME;
}

function readStoredTheme() {
    let storedTheme = null;
    try {
        storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    } catch (_error) {
        storedTheme = null;
    }
    return normalizeTheme(storedTheme);
}

function persistTheme(theme) {
    try {
        localStorage.setItem(THEME_STORAGE_KEY, normalizeTheme(theme));
    } catch (_error) {
        // Ignore storage failures.
    }
}

function applyTheme(theme) {
    const normalizedTheme = normalizeTheme(theme);
    document.documentElement.setAttribute("data-theme", normalizedTheme);
    return normalizedTheme;
}

function updateThemeToggle(theme) {
    const toggleButton = document.getElementById("theme-toggle");
    if (!toggleButton) {
        return;
    }

    const normalizedTheme = normalizeTheme(theme);
    const nextTheme = normalizedTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
    const nextThemeText = nextTheme === LIGHT_THEME ? "light" : "dark";
    const currentThemeText = normalizedTheme === LIGHT_THEME ? "light" : "dark";

    toggleButton.setAttribute("aria-label", "Switch to " + nextThemeText + " mode");
    toggleButton.setAttribute("title", "Theme: " + currentThemeText + ". Switch to " + nextThemeText + " mode");
    toggleButton.setAttribute("aria-pressed", normalizedTheme === LIGHT_THEME ? "true" : "false");
}

function applyInitialTheme() {
    const initialTheme = readStoredTheme();
    applyTheme(initialTheme);
}

function setupThemeToggle() {
    const toggleButton = document.getElementById("theme-toggle");
    if (!toggleButton) {
        return;
    }

    const currentTheme = applyTheme(readStoredTheme());
    updateThemeToggle(currentTheme);

    toggleButton.addEventListener("click", function() {
        const activeTheme = normalizeTheme(document.documentElement.getAttribute("data-theme"));
        const nextTheme = activeTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
        const appliedTheme = applyTheme(nextTheme);
        persistTheme(appliedTheme);
        updateThemeToggle(appliedTheme);

        if (lastResult) {
            drawPreview(lastResult);
        }
    });
}
