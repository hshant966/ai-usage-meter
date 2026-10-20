// Panel view catalogue and limit-window helpers shared by the applet and the popup.
var VIEWS = [
    { id: "today", name: "Today's tokens", short: "Tokens" },
    { id: "5h-reset", name: "5-hour reset countdown", short: "5h reset" },
    { id: "5h", name: "5-hour usage", short: "5h %" },
    { id: "pace", name: "5-hour pace", short: "Pace" },
    { id: "week", name: "Weekly usage", short: "Week %" },
    { id: "wk-reset", name: "Weekly reset countdown", short: "Wk reset" }
];
var NONE_VIEW = { id: "none", name: "Nothing", short: "Off" };

var SESSION_PATTERN = /session|5-hour/i;
var WEEKLY_PATTERN = /week|7-day/i;

function findLimit(record, pattern) {
    let limits = record ? (record.limits || []) : [];
    for (let i = 0; i < limits.length; i++) {
        if (pattern.test(String(limits[i].label || ""))) {
            return limits[i];
        }
    }
    return null;
}

// Window length in hours from a limit label: "Session (5-hour)", "Weekly (7-day)", "720h window".
function windowHours(label) {
    let text = String(label || "");
    if (SESSION_PATTERN.test(text)) {
        return 5;
    }
    if (WEEKLY_PATTERN.test(text)) {
        return 168;
    }
    let match = text.match(/(\d+)\s*h/i);
    return match ? Number(match[1]) : null;
}

// Fraction of the limit window already elapsed (0..1), or null when unknown.
function elapsedFraction(limit) {
    if (!limit || !limit.resetsAt) {
        return null;
    }
    let hours = windowHours(limit.label);
    let reset = new Date(limit.resetsAt).getTime();
    if (!hours || isNaN(reset)) {
        return null;
    }
    let elapsed = 1 - (reset - Date.now()) / (hours * 3600 * 1000);
    return elapsed < 0 || elapsed > 1 ? null : elapsed;
}

function optionName(options, id) {
    for (let i = 0; i < options.length; i++) {
        if (options[i].id === id) {
            return options[i].short || options[i].name;
        }
    }
    return options[0].short || options[0].name;
}

function nextOption(options, id, step) {
    let index = 0;
    for (let i = 0; i < options.length; i++) {
        if (options[i].id === id) {
            index = i;
        }
    }
    return options[((index + step) % options.length + options.length) % options.length].id;
}
