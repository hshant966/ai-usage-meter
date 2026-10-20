// Details popup: header, one card per provider, footer, and a collapsed Customize section.
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const Clutter = imports.gi.Clutter;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Cairo = imports.cairo;
const Format = require("./format");
const Render = require("./render");
const Views = require("./views");

const ACCENTS = { claude: "#D97757", codex: "#10A37F", hermes: "#8B7CF6", antigravity: "#4C8DF6" };
const DEFAULT_ACCENT = "#9AA0A6";
const BAR_TRACK = [0.5, 0.5, 0.5, 0.28];
const BAR_HEIGHT = 12;
const BAR_THICKNESS = 8;
const MAX_STATUS_CHARS = 90;
const SOON_MINUTES = 10;

function hex(rgba) {
    let part = function(v) { return ("0" + Math.round(v * 255).toString(16)).slice(-2); };
    return "#" + part(rgba[0]) + part(rgba[1]) + part(rgba[2]);
}

function accentOf(record) {
    return ACCENTS[record.id] || DEFAULT_ACCENT;
}

function label(text, styleClass, style) {
    let actor = new St.Label({ text: text, style_class: styleClass || "" });
    if (style) {
        actor.set_style(style);
    }
    return actor;
}

function addRow(menu, actor) {
    let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "aiusage-item" });
    item.addActor(actor, { span: -1, expand: true });
    menu.addMenuItem(item);
    return item;
}

function hbox(styleClass) {
    return new St.BoxLayout({ vertical: false, style_class: styleClass || "" });
}

function spacer() {
    let bin = new St.Bin();
    bin.x_expand = true;
    return bin;
}

function button(text, active, onClick, styleClass) {
    let btn = new St.Button({
        label: text,
        style_class: (styleClass || "aiusage-btn") + (active ? " aiusage-btn-active" : ""),
        x_expand: true
    });
    btn.connect("clicked", onClick);
    return btn;
}

// Track, fill and pace tick in one DrawingArea: one actor instead of three.
function progressBar(percent, elapsed) {
    let area = new St.DrawingArea({ style_class: "aiusage-bar" });
    area.set_height(BAR_HEIGHT);
    area.x_expand = true;
    area.connect("repaint", function() {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        let y = (h - BAR_THICKNESS) / 2;
        let r = BAR_THICKNESS / 2;
        let segment = function(width, rgba) {
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(BAR_THICKNESS);
            cr.moveTo(r, y + r);
            cr.lineTo(Math.max(r, width - r), y + r);
            cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
            cr.stroke();
        };
        segment(w, BAR_TRACK);
        let ratio = Math.max(0, Math.min(1, Number(percent || 0) / 100));
        if (ratio > 0.005) {
            segment(Math.max(BAR_THICKNESS, w * ratio), Render.statusColor(percent));
        }
        if (elapsed !== null && elapsed !== undefined) {
            let x = Math.round(w * elapsed) + 0.5;
            cr.setLineCap(Cairo.LineCap.BUTT);
            cr.setLineWidth(3);
            cr.setSourceRGBA(0, 0, 0, 0.45);
            cr.moveTo(x, 0);
            cr.lineTo(x, h);
            cr.stroke();
            cr.setLineWidth(1.5);
            cr.setSourceRGBA(0.95, 0.95, 0.95, 1);
            cr.moveTo(x, 0);
            cr.lineTo(x, h);
            cr.stroke();
        }
        cr.$dispose();
    });
    return area;
}

function addHeader(applet, menu) {
    let box = new St.BoxLayout({ vertical: true, style_class: "aiusage-header" });
    let top = hbox();
    top.add_actor(label("AI USAGE", "aiusage-secondary aiusage-caps"));
    top.add_actor(spacer());
    let updated = applet.refreshing ? "refreshing…" : (applet.isStale() ? "stale · " : "") + Format.ageText(applet.dataTime());
    top.add_actor(label(updated, applet.isStale() ? "aiusage-secondary aiusage-warn" : "aiusage-secondary"));
    box.add_actor(top);

    let hero = hbox();
    hero.add_actor(label(Format.shortTokens(applet._totalTokens()), "aiusage-total"));
    hero.add_actor(label(" tokens today", "aiusage-secondary aiusage-hero-unit"));
    box.add_actor(hero);

    let totals = applet.records.reduce(function(acc, r) {
        return { prompts: acc.prompts + Number(r.todayPrompts || 0), sessions: acc.sessions + Number(r.todaySessions || 0) };
    }, { prompts: 0, sessions: 0 });
    box.add_actor(label("7d " + Format.shortTokens(applet._weekTokens()) + " · " + totals.prompts + " prompts · " + totals.sessions + " sessions", "aiusage-secondary"));
    addRow(menu, box);
}

function limitBlock(limit, stale) {
    let percent = Number(limit.percent || 0) * 100;
    let block = new St.BoxLayout({ vertical: true, style_class: "aiusage-limit" });

    let top = hbox();
    top.add_actor(label(shortLimitName(limit.label), "aiusage-secondary aiusage-limit-name"));
    top.add_actor(spacer());
    top.add_actor(label(String(Math.round(percent)), "aiusage-pct", "color: " + hex(Render.statusColor(percent)) + ";"));
    top.add_actor(label("% used", "aiusage-secondary aiusage-pct-unit"));
    block.add_actor(top);

    block.add_actor(progressBar(percent, stale ? null : Views.elapsedFraction(limit)));

    if (limit.resetsAt) {
        let minutes = Format.minutesUntil(limit.resetsAt);
        let row = hbox("aiusage-countdown-row");
        let soon = minutes !== null && minutes < SOON_MINUTES;
        row.add_actor(label(Format.countdownLong(limit.resetsAt), soon ? "aiusage-countdown aiusage-warn" : "aiusage-countdown"));
        row.add_actor(label(" left", "aiusage-secondary aiusage-countdown-unit"));
        row.add_actor(spacer());
        row.add_actor(label("resets " + Format.whenText(limit.resetsAt), "aiusage-secondary"));
        block.add_actor(row);
    }
    if (stale) {
        block.opacity = 115;
    }
    return block;
}

function shortLimitName(text) {
    let value = String(text || "Usage");
    if (Views.SESSION_PATTERN.test(value)) {
        return "5-hour";
    }
    if (Views.WEEKLY_PATTERN.test(value)) {
        return "Weekly";
    }
    return value;
}

function tokenLines(record) {
    let tokens = Number(record.todayTotalTokens || 0);
    if (!record.hasLocalStats && tokens === 0) {
        return [];
    }
    let line = "Today " + Format.shortTokens(tokens) + " tok · " + Number(record.todayPrompts || 0) + " prompts · " + Number(record.todaySessions || 0) + " sessions";
    if (record.todayCostUSD !== undefined && record.todayCostUSD !== null && Number(record.todayCostUSD) > 0) {
        line += " · " + Format.money(record.todayCostUSD);
    }
    return [line];
}

function addCard(applet, menu, record) {
    let status = record.usageStatusText || record.authHelpText || "";
    let failed = (record.limits || []).length === 0 && status;
    let accent = failed ? hex(Render.CRIT) : accentOf(record);
    let card = new St.BoxLayout({ vertical: true, style_class: "aiusage-card" });
    card.set_style("border-left-color: " + accent + ";");

    let head = hbox("aiusage-card-head");
    head.add_actor(label(record.name || Format.titleCase(record.id), "aiusage-card-title"));
    head.add_actor(spacer());
    if (record === applet._gaugeRecord()) {
        head.add_actor(label("PANEL", "aiusage-chip aiusage-chip-panel", "color: " + accentOf(record) + ";"));
    }
    if (record.tierLabel) {
        head.add_actor(label(record.tierLabel, "aiusage-chip"));
    }
    card.add_actor(head);

    let limits = record.limits || [];
    for (let i = 0; i < limits.length; i++) {
        card.add_actor(limitBlock(limits[i], record.limitsStale));
    }
    if (status) {
        let short = status.length > MAX_STATUS_CHARS ? status.slice(0, MAX_STATUS_CHARS - 1) + "…" : status;
        let msg = label(short, failed ? "aiusage-status aiusage-crit" : "aiusage-status aiusage-secondary");
        msg.clutter_text.line_wrap = true;
        card.add_actor(msg);
    }
    let lines = tokenLines(record);
    for (let i = 0; i < lines.length; i++) {
        card.add_actor(label(lines[i], i === 0 ? "aiusage-tokens" : "aiusage-secondary"));
    }
    return addRow(menu, card);
}

function addFooter(applet, menu) {
    let row = hbox("aiusage-footer");
    let refresh = button("⟳  Refresh", false, function() { applet._refresh(true); }, "aiusage-footer-btn");
    let settings = button("⚙  Settings", false, function() { applet.menu.close(); applet.configureApplet(); }, "aiusage-footer-btn");
    let customize = button(applet.customizeOpen ? "✓  Done" : "✎  Customize", applet.customizeOpen, function() {
        applet.customizeOpen = !applet.customizeOpen;
        applet._buildMenu();
    }, "aiusage-footer-btn");
    [refresh, settings, customize].forEach(function(btn) {
        btn.x_expand = false;
        row.add_actor(btn);
    });
    row.add_actor(spacer());
    row.add_actor(label("Updated " + (applet.lastUpdated ? Format.clockText(applet.lastUpdated) : "never"), "aiusage-secondary aiusage-footer-time"));
    addRow(menu, row);
}

// Native Cinnamon dropdowns, one per panel slot; choosing an option closes the popup so the bar change is visible.
// One row of three buttons; each opens a floating list (Cinnamon's combo menu) so the popup layout never shifts.
function addSlotButtons(applet, menu) {
    let withNone = [Views.NONE_VIEW].concat(Views.VIEWS);
    let slots = [
        { key: "slot-left", prop: "slotLeft", name: "Left", options: withNone },
        { key: "panel-view", prop: "panelView", name: "Middle", options: Views.VIEWS },
        { key: "slot-right", prop: "slotRight", name: "Right", options: withNone }
    ];
    let row = hbox("aiusage-btn-row");
    slots.forEach(function(slot) {
        let current = applet[slot.prop] || slot.options[0].id;
        let btn = button(slot.name + ": " + Views.optionName(slot.options, current) + "  ▾", true, function() {
            openDropdown(applet, btn, slot, current);
        });
        row.add_actor(btn);
    });
    addRow(menu, row);
}

const REOPEN_GUARD_MS = 300;

// Floating list under the button. The popup's menu manager closes everything on a click outside its
// own actor or on a key-focus change, so while the list is open the popup passes events through and
// the list never takes key focus.
function openDropdown(applet, source, slot, current) {
    if (applet.dropdown) {
        applet.dropdown.close();
        return;
    }
    // A press on the same button closes the list first; don't reopen it on that same click.
    if (applet.dropdownClosed && applet.dropdownClosed.key === slot.key && Date.now() - applet.dropdownClosed.at < REOPEN_GUARD_MS) {
        return;
    }
    let list = new PopupMenu.PopupComboMenu(source);
    Main.uiGroup.add_actor(list.actor);
    list.actor.add_style_class_name("aiusage-dropdown");
    slot.options.forEach(function(option) {
        let item = new PopupMenu.PopupMenuItem(option.name);
        // Hover would otherwise pull key focus out of the popup, which closes it.
        item.focusOnHover = false;
        item.setOrnament(PopupMenu.OrnamentType.DOT, option.id === current);
        item.connect("activate", function() {
            // Finish this click before tearing the list down and rebuilding the popup.
            Mainloop.idle_add(function() {
                list.close();
                applet._setSetting(slot.key, slot.prop, option.id);
                return false;
            });
        });
        list.addMenuItem(item);
    });

    let captureId = global.stage.connect("captured-event", function(actor, event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && !list.actor.contains(event.get_source())) {
            list.close();
        }
        return Clutter.EVENT_PROPAGATE;
    });
    list.open = function() {
        let [x, y] = source.get_transformed_position();
        list.actor.set_position(Math.round(x), Math.round(y + source.height + 2));
        list.actor.raise_top();
        list.actor.show();
        list.isOpen = true;
        list.emit("open-state-changed", true);
    };
    list.close = function() {
        if (!list.isOpen) {
            return;
        }
        list.isOpen = false;
        global.stage.disconnect(captureId);
        applet.menu.passEvents = false;
        applet.dropdown = null;
        applet.dropdownClosed = { key: slot.key, at: Date.now() };
        list.actor.hide();
        list.emit("open-state-changed", false);
        Mainloop.idle_add(function() {
            list.destroy();
            return false;
        });
    };

    applet.menu.passEvents = true;
    applet.dropdown = list;
    list.open();
}

function addDesignControls(applet, menu) {
    let row = hbox("aiusage-seg");
    let current = applet.design || "arc";
    Render.DESIGNS.forEach(function(option) {
        row.add_actor(button(option.name, option.id === current, function() {
            applet._setSetting("design", "design", option.id);
        }, "aiusage-seg-btn"));
    });
    addRow(menu, row);
}

function addSwitch(menu, text, state, onToggle) {
    let item = new PopupMenu.PopupSwitchMenuItem(text, state);
    item.connect("toggled", function(sender, value) { onToggle(value); });
    menu.addMenuItem(item);
}

function captionItem(text) {
    let item = new PopupMenu.PopupMenuItem(text, { reactive: false });
    item.label.add_style_class_name("aiusage-secondary");
    item.label.add_style_class_name("aiusage-caption");
    return item;
}

// Every provider, including hidden ones, so they can be shown again.
function addProviderControls(applet, menu) {
    menu.addMenuItem(captionItem("Providers"));
    let hidden = applet._hiddenIds();
    let gauge = applet._gaugeRecord();
    applet.allRecords.forEach(function(record) {
        let row = hbox("aiusage-provider-row");
        row.add_actor(label("●", "aiusage-dot", "color: " + accentOf(record) + ";"));
        let name = label(record.name || Format.titleCase(record.id), "aiusage-provider-name");
        name.x_expand = true;
        row.add_actor(name);
        let isHidden = hidden.indexOf(record.id) >= 0;
        let show = button(isHidden ? "Hidden" : "Shown", !isHidden, function() {
            applet._setProviderHidden(record.id, !isHidden);
        }, "aiusage-mini-btn");
        show.x_expand = false;
        row.add_actor(show);
        if ((record.limits || []).length > 0) {
            let panel = button("Panel", record === gauge, function() { applet._setGaugeProvider(record.id); }, "aiusage-mini-btn");
            panel.x_expand = false;
            row.add_actor(panel);
        }
        addRow(menu, row);
    });
}

// Customize replaces the provider cards so the popup never grows taller than the screen.
function addCustomize(applet, menu) {
    addSwitch(menu, "Auto-shuffle middle view", !!applet.autoCycle, function(v) { applet._setAutoCycle(v); });
    addSwitch(menu, "Shuffle designs", !!applet.designShuffle, function(v) {
        applet._setSetting("design-shuffle", "designShuffle", v);
    });
    addProviderControls(applet, menu);
}

function build(applet) {
    let menu = applet.menu;
    menu.removeAll();
    addHeader(applet, menu);
    addSlotButtons(applet, menu);
    addDesignControls(applet, menu);
    if (applet.records.length === 0) {
        let empty = applet.allRecords.length > 0 ? "All providers are hidden. Open Customize to show them."
            : (applet.refreshing ? "Loading usage…" : "No usage data yet. Press Refresh.");
        menu.addMenuItem(captionItem(empty));
    }
    if (applet.customizeOpen) {
        addCustomize(applet, menu);
    } else {
        for (let i = 0; i < applet.records.length; i++) {
            addCard(applet, menu, applet.records[i]);
        }
    }
    addFooter(applet, menu);
}
