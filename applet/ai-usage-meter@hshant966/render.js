// Panel drawing: one Cairo pass per repaint, nothing kept between frames.
const Cairo = imports.cairo;

var HEIGHT = 24;
var SIDE_WIDTH = 40;
var CENTER_WIDTH = 50;
var PAD = 2;
var DESIGNS = [
    { id: "arc", name: "Arc" },
    { id: "bars", name: "Bars" },
    { id: "ring", name: "Ring" }
];

var OK = [0.24, 0.86, 0.52, 1];
var WARN = [1.0, 0.69, 0.13, 1];
var CRIT = [1.0, 0.30, 0.31, 1];
const TRACK = [1, 1, 1, 0.18];
const LOADING = [0.45, 0.65, 1, 0.8];
const TAG = [1, 1, 1, 0.62];
const TEXT = [1, 1, 1, 0.95];
const TICK = [1, 1, 1, 0.9];
const GLOW = [1.0, 0.30, 0.31, 0.12];
const TAG_Y = 9;
const VAL_Y = 20.5;
const VAL_SIZE = 10;
const STALE_ALPHA = 0.45;
var WARN_AT = 65;
var CRIT_AT = 90;

function width(state) {
    return PAD * 2 + CENTER_WIDTH + (state.left ? SIDE_WIDTH : 0) + (state.right ? SIDE_WIDTH : 0);
}

function statusColor(percent) {
    let p = Number(percent || 0);
    return p >= CRIT_AT ? CRIT : (p >= WARN_AT ? WARN : OK);
}

function ratioOf(percent) {
    return Math.max(0, Math.min(1, Number(percent || 0) / 100));
}

function setColor(cr, rgba) {
    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
}

function font(cr, bold, size) {
    cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
    cr.setFontSize(size);
}

// Draws text aligned "center" or "left" at x; shrinks one step when it would overflow maxWidth.
function text(cr, value, x, baseline, opts) {
    font(cr, opts.bold, opts.size);
    let extents = cr.textExtents(value);
    if (opts.maxWidth && extents.width > opts.maxWidth) {
        font(cr, opts.bold, opts.size - 1);
        extents = cr.textExtents(value);
    }
    let left = opts.align === "left" ? x : x - extents.width / 2 - extents.xBearing;
    cr.moveTo(Math.round(left), baseline);
    setColor(cr, opts.color);
    cr.showText(value);
    if (opts.underline) {
        cr.rectangle(Math.round(left), baseline + 2, extents.width, 1);
        cr.fill();
    }
}

function valueText(state, view) {
    return state.stale === 2 ? "--" : view.text;
}

function valueColor(view) {
    return view.tint ? statusColor(view.percent) : TEXT;
}

function isUrgentView(view) {
    return !!view.tint && Number(view.percent || 0) >= CRIT_AT;
}

// Tag over value, the same baselines in every slot.
function label(cr, state, view, x, maxWidth, align) {
    text(cr, view.tag, x, TAG_Y, { size: 6.5, color: TAG, align: align, maxWidth: maxWidth });
    text(cr, valueText(state, view), x, VAL_Y, {
        bold: true, size: VAL_SIZE, color: valueColor(view), align: align, maxWidth: maxWidth, underline: isUrgentView(view)
    });
}

function fillColor(state, percent) {
    if (state.mode === "error") {
        return CRIT;
    }
    if (state.mode === "loading") {
        return LOADING;
    }
    return statusColor(percent);
}

function stroke(cr, rgba, lineWidth) {
    setColor(cr, rgba);
    cr.setLineWidth(lineWidth);
    cr.stroke();
}

// Elapsed fraction of the window the view belongs to; null hides the pace tick.
function elapsedFor(state, view) {
    if (!view || state.stale || state.mode !== "normal") {
        return null;
    }
    if (view.window === "5h") {
        return state.sessionElapsed;
    }
    if (view.window === "week") {
        return state.weeklyElapsed;
    }
    return null;
}

function radialTick(cr, cx, cy, radius, angle, half) {
    cr.setLineCap(Cairo.LineCap.BUTT);
    cr.moveTo(cx + Math.cos(angle) * (radius - half), cy + Math.sin(angle) * (radius - half));
    cr.lineTo(cx + Math.cos(angle) * (radius + half), cy + Math.sin(angle) * (radius + half));
    stroke(cr, TICK, 1.2);
    cr.setLineCap(Cairo.LineCap.ROUND);
}

function drawArc(cr, state, x0) {
    let view = state.middle;
    let cx = x0 + CENTER_WIDTH / 2;
    let cy = HEIGHT - 2.5;
    let radius = 20;
    let percent = view ? view.percent : 0;
    let ratio = state.mode === "normal" && state.stale !== 2 ? ratioOf(percent) : 0;

    cr.arc(cx, cy, radius, Math.PI, Math.PI * 2);
    stroke(cr, TRACK, 3);
    if (ratio > 0.005 || state.mode !== "normal") {
        let sweep = state.mode === "normal" ? ratio : 0.3;
        cr.arc(cx, cy, radius, Math.PI, Math.PI + Math.PI * Math.max(0.02, sweep));
        stroke(cr, fillColor(state, percent), 3);
    }
    let elapsed = elapsedFor(state, view);
    if (elapsed !== null) {
        radialTick(cr, cx, cy, radius, Math.PI + Math.PI * elapsed, 3.5);
    }
    if (view && state.mode === "normal") {
        text(cr, view.tag, cx, 11, { size: 6.5, color: TAG, maxWidth: 30 });
        text(cr, valueText(state, view), cx, VAL_Y, {
            bold: true, size: VAL_SIZE, color: valueColor(view), maxWidth: 34, underline: isUrgentView(view)
        });
    }
}

function roundedBar(cr, x, y, w, h, rgba) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(h);
    cr.moveTo(x + h / 2, y + h / 2);
    cr.lineTo(x + Math.max(h / 2, w - h / 2), y + h / 2);
    setColor(cr, rgba);
    cr.stroke();
}

function bar(cr, state, x, y, w, percent, elapsed) {
    let h = 3.5;
    roundedBar(cr, x, y, w, h, TRACK);
    let ratio = state.stale === 2 ? 0 : ratioOf(percent);
    if (ratio > 0.005) {
        roundedBar(cr, x, y, Math.max(h, w * ratio), h, fillColor(state, percent));
    }
    if (elapsed !== null && elapsed !== undefined && !state.stale) {
        let tx = Math.round(x + w * elapsed) + 0.5;
        cr.setLineCap(Cairo.LineCap.BUTT);
        cr.moveTo(tx, y - 1);
        cr.lineTo(tx, y + h + 1);
        stroke(cr, TICK, 1.2);
    }
}

// Value row on top, then 5-hour and weekly bars that are always visible.
function drawBars(cr, state, x0) {
    let view = state.middle;
    let x = x0 + 3;
    let w = CENTER_WIDTH - 6;
    if (view && state.mode === "normal") {
        let value = valueText(state, view);
        font(cr, true, VAL_SIZE);
        let valueExtents = cr.textExtents(value);
        font(cr, false, 6.5);
        let tagExtents = cr.textExtents(view.tag);
        let valueOpts = { bold: true, size: VAL_SIZE, color: valueColor(view), align: "left", underline: isUrgentView(view) };
        // Tag left + value right when both fit; otherwise the value alone, centered.
        if (tagExtents.width + valueExtents.width + 3 <= w) {
            text(cr, view.tag, x, 10, { size: 6.5, color: TAG, align: "left" });
            text(cr, value, x + w - valueExtents.width - valueExtents.xBearing, 10.5, valueOpts);
        } else {
            text(cr, value, x + w / 2 - valueExtents.width / 2 - valueExtents.xBearing, 10.5, valueOpts);
        }
    }
    let live = state.mode === "normal";
    bar(cr, state, x, 14, w, live ? state.session : 0, live ? state.sessionElapsed : null);
    bar(cr, state, x, 19.5, w, live ? state.weekly : 0, live ? state.weeklyElapsed : null);
}

// Outer ring = 5-hour, inner ring = weekly; text block to the right, left-aligned.
function drawRing(cr, state, x0) {
    let rx = x0 + 12;
    let ry = HEIGHT / 2;
    let rings = [[10, 2.8, state.session, state.sessionElapsed], [5.5, 2.4, state.weekly, null]];
    for (let i = 0; i < rings.length; i++) {
        let [radius, lineWidth, percent, elapsed] = rings[i];
        let ratio = state.mode === "normal" && state.stale !== 2 ? ratioOf(percent) : 0;
        cr.arc(rx, ry, radius, 0, Math.PI * 2);
        stroke(cr, TRACK, lineWidth);
        let start = -Math.PI / 2;
        if (ratio > 0.005 || state.mode !== "normal") {
            let sweep = state.mode === "normal" ? ratio : 0.3;
            cr.arc(rx, ry, radius, start, start + Math.PI * 2 * sweep);
            stroke(cr, fillColor(state, percent), lineWidth);
        }
        if (elapsed !== null && elapsed !== undefined && !state.stale && state.mode === "normal") {
            radialTick(cr, rx, ry, radius, start + Math.PI * 2 * elapsed, 2.6);
        }
    }
    if (state.middle && state.mode === "normal") {
        label(cr, state, state.middle, rx + 16, CENTER_WIDTH - 28, "left");
    }
}

const DRAWERS = { arc: drawArc, bars: drawBars, ring: drawRing };

function drawSlots(cr, state, w) {
    let x = PAD;
    if (state.urgent && state.mode === "normal") {
        let glowX = x + (state.left ? SIDE_WIDTH : 0);
        cr.rectangle(glowX, 0, CENTER_WIDTH, HEIGHT);
        setColor(cr, GLOW);
        cr.fill();
    }
    if (state.left) {
        if (state.mode === "normal") {
            label(cr, state, state.left, x + SIDE_WIDTH / 2, SIDE_WIDTH - 4, "center");
        }
        x += SIDE_WIDTH;
    }
    (DRAWERS[state.design] || drawArc)(cr, state, x);
    x += CENTER_WIDTH;
    if (state.right && state.mode === "normal") {
        label(cr, state, state.right, x + SIDE_WIDTH / 2, SIDE_WIDTH - 4, "center");
    }
}

function draw(area, state) {
    let cr = area.get_context();
    let [w] = area.get_surface_size();
    cr.setLineCap(Cairo.LineCap.ROUND);
    // Stale data is drawn through a group so it can be dimmed; the normal path pays nothing extra.
    if (state.stale) {
        cr.pushGroup();
        drawSlots(cr, state, w);
        cr.popGroupToSource();
        cr.paintWithAlpha(STALE_ALPHA);
    } else {
        drawSlots(cr, state, w);
    }
    cr.$dispose();
}
