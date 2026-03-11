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

const WORKER_CACHE_KEY = 1;
const THEME_STORAGE_KEY = "circle_generator_theme";
const DARK_THEME = "dark";
const LIGHT_THEME = "light";
const VIEW_MODE_FULL = "full";
const VIEW_MODE_NE = "ne";
const VIEW_MODE_NW = "nw";
const VIEW_MODE_SE = "se";
const VIEW_MODE_SW = "sw";

const ui = {};

applyInitialTheme();

window.addEventListener("load", initializeApp);

async function initializeApp() {
    cacheElements();
    setupThemeToggle();
    initializeInputs();
    bindEvents();
    document.title = data.appTitle || "Circle Generator";
    updateThemeToggle(normalizeTheme(document.documentElement.getAttribute("data-theme")));

    resetWorker();
    requestGeneration();
}

function cacheElements() {
    ui.form = document.getElementById("generator-form");
    ui.radius = document.getElementById("radius");
    ui.thickness = document.getElementById("thickness");
    ui.zoom = document.getElementById("zoom");
    ui.zoomValue = document.getElementById("zoom-value");
    ui.viewMode = document.getElementById("view-mode");
    ui.previewShell = document.getElementById("preview-shell");
    ui.canvas = document.getElementById("circle-canvas");
    ui.previewSize = document.getElementById("preview-size");
    ui.error = document.getElementById("error");
    ui.errorMessage = document.getElementById("error-message");
}

function initializeInputs() {
    ui.radius.min = String(data.minRadius);
    ui.radius.max = String(data.maxRadius);
    ui.radius.value = String(data.defaultRadius);

    ui.thickness.min = String(data.minThickness);
    ui.thickness.max = String(Math.min(data.maxThickness, data.maxRadius));
    ui.thickness.value = String(data.defaultThickness);

    ui.zoom.min = String(data.zoom.sliderMin);
    ui.zoom.max = String(data.zoom.sliderMax);
    ui.zoom.step = String(data.zoom.sliderStep);
    currentZoom = clampNumber(data.zoom.default, data.zoom.min, data.zoom.max, data.zoom.default);
    syncZoomSliderToCurrent();
    updateZoomLabel();
}

function bindEvents() {
    ui.form.addEventListener("submit", function(event) {
        event.preventDefault();
        requestGeneration();
    });

    ui.radius.addEventListener("input", requestGeneration);
    ui.thickness.addEventListener("input", requestGeneration);
    ui.radius.addEventListener("change", requestGeneration);
    ui.thickness.addEventListener("change", requestGeneration);

    ui.zoom.addEventListener("input", function() {
        currentZoom = sliderValueToZoom(ui.zoom.value);
        updateZoomLabel();
        if (lastResult) {
            drawPreview(lastResult);
        }
    });
    ui.viewMode.addEventListener("change", function() {
        if (lastResult) {
            renderResult(lastResult);
        }
    });

    ui.previewShell.addEventListener("wheel", handlePreviewWheel, { passive: false });
    ui.previewShell.addEventListener("mousedown", handlePreviewDragStart);
    window.addEventListener("mousemove", handlePreviewDragMove);
    window.addEventListener("mouseup", handlePreviewDragEnd);
    ui.canvas.addEventListener("click", handleCanvasClick);
}

function requestGeneration() {
    if (!worker) {
        resetWorker();
    }

    const parsedRadius = Number.parseInt(ui.radius.value, 10);
    const parsedThickness = Number.parseInt(ui.thickness.value, 10);
    if (!Number.isFinite(parsedRadius) || !Number.isFinite(parsedThickness)) {
        return;
    }

    const radius = clampInt(parsedRadius, data.minRadius, data.maxRadius, data.defaultRadius);
    const maxThicknessForRadius = Math.min(data.maxThickness, radius);
    const thickness = clampInt(parsedThickness, data.minThickness, maxThicknessForRadius, data.defaultThickness);
    const centerX = data.defaultCenter.x;
    const centerY = data.defaultCenter.y;
    const centerZ = data.defaultCenter.z;

    ui.radius.value = String(radius);
    ui.thickness.max = String(maxThicknessForRadius);
    ui.thickness.value = String(thickness);

    const payload = {
        radius: radius,
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
        renderResult(lastResult);
        return;
    }

    const workerError = message.error || "Unknown generation error";
    showError(workerError);
}

function renderResult(result) {
    const viewBounds = getViewBounds(result, getCurrentViewMode());
    const width = viewBounds.maxColumn - viewBounds.minColumn;
    const height = viewBounds.maxRow - viewBounds.minRow;

    if (getCurrentViewMode() === VIEW_MODE_FULL) {
        ui.previewSize.textContent = width + " x " + height;
    } else {
        ui.previewSize.textContent = width + " x " + height + " (quarter)";
    }

    drawPreview(result);
}

function drawPreview(result) {
    const zoom = getCurrentZoom();
    const viewBounds = getViewBounds(result, getCurrentViewMode());
    const viewWidth = viewBounds.maxColumn - viewBounds.minColumn;
    const viewHeight = viewBounds.maxRow - viewBounds.minRow;
    const canvas = ui.canvas;
    const context = canvas.getContext("2d");

    canvas.width = Math.max(1, Math.round(viewWidth * zoom));
    canvas.height = Math.max(1, Math.round(viewHeight * zoom));

    context.fillStyle = document.documentElement.getAttribute("data-theme") === LIGHT_THEME ? "#f3f8ff" : "#0f1622";
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (zoom >= 10) {
        context.strokeStyle = document.documentElement.getAttribute("data-theme") === LIGHT_THEME ? "#d9e5f3" : "#233145";
        context.lineWidth = 1;

        for (let line = 0; line <= viewWidth; line += 1) {
            const offset = line * zoom + 0.5;

            context.beginPath();
            context.moveTo(offset, 0);
            context.lineTo(offset, canvas.height);
            context.stroke();
        }

        for (let line = 0; line <= viewHeight; line += 1) {
            const offset = line * zoom + 0.5;
            context.beginPath();
            context.moveTo(0, offset);
            context.lineTo(canvas.width, offset);
            context.stroke();
        }
    }

    const centerLineX = (result.radius - viewBounds.minColumn) * zoom + zoom / 2;
    const centerLineY = (result.radius - viewBounds.minRow) * zoom + zoom / 2;
    context.strokeStyle = document.documentElement.getAttribute("data-theme") === LIGHT_THEME ? "#8ca8ce" : "#3c5d87";
    context.lineWidth = 1;

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
    const blockColor = selectedBlock ? selectedBlock.color : "#9fa3a8";
    const completedBlockColor = document.documentElement.getAttribute("data-theme") === LIGHT_THEME ? "#2a9650" : "#39be65";

    result.relativePoints.forEach(function(point) {
        if (!isPointVisibleInCurrentView(point.x, point.z)) {
            return;
        }

        const pointKey = serializePoint(point.x, point.z);
        const column = point.x + result.radius;
        const row = result.radius - point.z;
        const pixelX = (column - viewBounds.minColumn) * zoom;
        const pixelY = (row - viewBounds.minRow) * zoom;
        const inset = zoom >= 6 ? Math.max(1, Math.floor(zoom * 0.12)) : 0;
        const drawSize = Math.max(zoom - inset * 2, 0.25);

        context.fillStyle = completedPointKeys.has(pointKey) ? completedBlockColor : blockColor;
        context.fillRect(pixelX + inset, pixelY + inset, drawSize, drawSize);
    });
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
    const worldX = canvasPointerX / zoomBeforeWheel;
    const worldY = canvasPointerY / zoomBeforeWheel;

    currentZoom = nextZoom;
    syncZoomSliderToCurrent();
    updateZoomLabel();
    drawPreview(lastResult);

    const newCanvasLeft = ui.canvas.offsetLeft;
    const newCanvasTop = ui.canvas.offsetTop;
    const nextPointerContentX = newCanvasLeft + worldX * nextZoom;
    const nextPointerContentY = newCanvasTop + worldY * nextZoom;

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
    const viewBounds = getViewBounds(lastResult, getCurrentViewMode());
    const canvasRect = ui.canvas.getBoundingClientRect();
    const canvasX = event.clientX - canvasRect.left;
    const canvasY = event.clientY - canvasRect.top;
    const column = Math.floor(canvasX / zoom) + viewBounds.minColumn;
    const row = Math.floor(canvasY / zoom) + viewBounds.minRow;

    if (column < 0 || row < 0 || column >= lastResult.diameter || row >= lastResult.diameter) {
        return;
    }

    const pointX = column - lastResult.radius;
    const pointZ = lastResult.radius - row;
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
    const mode = getCurrentViewMode();
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
    const diameter = result.diameter;
    const radius = result.radius;

    if (mode === VIEW_MODE_NE) {
        return { minColumn: radius, maxColumn: diameter, minRow: 0, maxRow: Math.min(diameter, radius + 1) };
    }
    if (mode === VIEW_MODE_NW) {
        return { minColumn: 0, maxColumn: Math.min(diameter, radius + 1), minRow: 0, maxRow: Math.min(diameter, radius + 1) };
    }
    if (mode === VIEW_MODE_SE) {
        return { minColumn: radius, maxColumn: diameter, minRow: radius, maxRow: diameter };
    }
    if (mode === VIEW_MODE_SW) {
        return { minColumn: 0, maxColumn: Math.min(diameter, radius + 1), minRow: radius, maxRow: diameter };
    }

    return { minColumn: 0, maxColumn: diameter, minRow: 0, maxRow: diameter };
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
