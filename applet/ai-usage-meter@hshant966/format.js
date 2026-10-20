// Text formatting shared by the panel, tooltip and popup.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortTokens(value) {
    let n = Number(value || 0);
    if (n >= 999.5e6) {
        return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
    }
    if (n >= 999500) {
        return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M";
    }
    if (n >= 1e3) {
        return Math.round(n / 1e3) + "K";
    }
    return String(Math.round(n));
}

function clockText(date) {
    let hours = date.getHours();
    let minutes = date.getMinutes();
    let h12 = hours % 12 === 0 ? 12 : hours % 12;
    return h12 + ":" + (minutes < 10 ? "0" : "") + minutes + " " + (hours >= 12 ? "pm" : "am");
}

// "6:29 pm" today, otherwise "Nov 19, 2:48 pm".
function whenText(value) {
    let date = new Date(value);
    if (isNaN(date.getTime())) {
        return "";
    }
    let sameDay = date.toDateString() === new Date().toDateString();
    return sameDay ? clockText(date) : MONTHS[date.getMonth()] + " " + date.getDate() + ", " + clockText(date);
}

function minutesUntil(value) {
    let ms = new Date(value).getTime() - Date.now();
    return isNaN(ms) ? null : Math.max(0, Math.ceil(ms / 60000));
}

// Compact for the panel: "3h42", "41m", "1d20h".
function countdown(value) {
    let minutes = minutesUntil(value);
    if (minutes === null) {
        return "?";
    }
    if (minutes === 0) {
        return "now";
    }
    let days = Math.floor(minutes / 1440);
    let hours = Math.floor((minutes % 1440) / 60);
    let mins = minutes % 60;
    if (days > 0) {
        return days + "d" + hours + "h";
    }
    if (hours > 0) {
        return hours + "h" + (mins < 10 ? "0" : "") + mins;
    }
    return mins + "m";
}

// Spaced for the popup: "3h 35m", "29d 23h", "41m".
function countdownLong(value) {
    let minutes = minutesUntil(value);
    if (minutes === null) {
        return "";
    }
    let days = Math.floor(minutes / 1440);
    let hours = Math.floor((minutes % 1440) / 60);
    let mins = minutes % 60;
    if (days > 0) {
        return days + "d " + hours + "h";
    }
    if (hours > 0) {
        return hours + "h " + mins + "m";
    }
    return mins + "m";
}

function ageText(date) {
    if (!date) {
        return "never";
    }
    let seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 45) {
        return "just now";
    }
    if (seconds < 3600) {
        return Math.floor(seconds / 60) + "m ago";
    }
    return clockText(date);
}

function money(value) {
    let n = Number(value);
    return isNaN(n) ? String(value) : "$" + n.toFixed(2);
}

function titleCase(value) {
    let text = String(value || "");
    return text.charAt(0).toUpperCase() + text.slice(1);
}
