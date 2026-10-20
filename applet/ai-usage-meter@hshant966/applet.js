const Applet = imports.ui.applet;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Util = imports.misc.util;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Render = require("./render");
const Popup = require("./popup");
const Format = require("./format");
const Views = require("./views");

const DEFAULT_UPDATE_COMMAND = "~/.local/share/ai-usage/bin/ai-usage-update";
const DEFAULT_GAUGE_PROVIDER = "claude";
const DEFAULT_REFRESH_SECONDS = 300;
const MIN_REFRESH_SECONDS = 60;
const WATCHDOG_SECONDS = 150;
const DEFAULT_CYCLE_SECONDS = 5;
const MIN_PACE_ELAPSED = 0.1;
const TICK_SECONDS = 30;
const STALE_MS = 15 * 60 * 1000;
const VERY_STALE_MS = 60 * 60 * 1000;
const ORDER = ["claude", "codex", "hermes", "antigravity"];
const USAGE_DIR = GLib.get_home_dir() + "/.local/state/omarchy/agents/usage";

class AiUsageMeterApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", Lang.bind(this, function(menu, open) {
            if (!open) {
                this.customizeOpen = false;
                if (this.dropdown) {
                    this.dropdown.close();
                }
            }
        }));

        this.refreshTimerId = 0;
        this.watchdogId = 0;
        this.cycleTimerId = 0;
        this.removed = false;
        this.refreshing = false;
        this.refreshSeq = 0;
        this.shuffledDesign = null;
        this.lastRefreshSeconds = 0;
        this.lastUpdated = null;
        this.customizeOpen = false;
        this.dropdown = null;
        this.records = [];
        this.allRecords = [];
        this.panelState = {};
        this.panelGaugeMode = "loading";
        this.drawnKey = "";

        this.panelGauge = new St.DrawingArea({ style_class: "aiusage-panel-gauge" });
        this.panelGauge.set_size(Render.CENTER_WIDTH, Render.HEIGHT);
        this.panelGauge.connect("repaint", Lang.bind(this, this._drawPanelGauge));
        this._layoutBin.set_child(this.panelGauge);
        this._layoutBin.show();
        this.actor.connect("scroll-event", Lang.bind(this, this._onScroll));

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        ["update-command:updateCommand", "gauge-provider:gaugeProvider", "refresh-interval:refreshInterval",
            "cycle-seconds:cycleSeconds", "panel-view:panelView", "auto-cycle:autoCycle", "slot-left:slotLeft",
            "slot-right:slotRight", "design:design", "design-shuffle:designShuffle", "hidden-providers:hiddenProviders"
        ].forEach(Lang.bind(this, function(pair) {
            let [key, prop] = pair.split(":");
            this.settings.bind(key, prop, this._onSettingsChanged);
        }));

        this._setPanelGauge("loading");
        this._loadRecords();
        this._refresh(false);
        this._scheduleRefresh();
        this._scheduleCycle();
    }

    // ---- interaction ----

    on_applet_clicked() {
        this._stepView(1);
    }

    // Right-click opens details; panel edit mode keeps Cinnamon's own menu for move/remove.
    _onButtonPressEvent(actor, event) {
        if (event.get_button() === 3 && !global.settings.get_boolean("panel-edit-mode")) {
            this._applet_context_menu.close();
            if (this.menu.isOpen) {
                this.menu.close();
            } else {
                this._buildMenu();
                this.menu.open();
            }
            return true;
        }
        return super._onButtonPressEvent(actor, event);
    }

    _onScroll(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP) {
            this._stepView(-1);
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            this._stepView(1);
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    on_applet_removed_from_panel() {
        this.removed = true;
        this._clearCycleTimer();
        this._clearWatchdog();
        this._clearRefreshTimer();
        this.settings.finalize();
    }

    // ---- settings ----

    _onSettingsChanged() {
        this.records = this._visibleRecords();
        this._onDataChanged();
        if (this._refreshSeconds() !== this.lastRefreshSeconds) {
            this._scheduleRefresh();
        }
        this._scheduleCycle();
    }

    _setSetting(key, prop, value) {
        this.settings.setValue(key, value);
        this[prop] = value;
        if (key === "design") {
            this.shuffledDesign = null;
        }
        this._showSlide();
        this._scheduleCycle();
        if (this.menu.isOpen) {
            this._buildMenu();
        }
    }

    _setAutoCycle(state) {
        this._setSetting("auto-cycle", "autoCycle", !!state);
    }

    _setProviderHidden(id, hide) {
        let hidden = this._hiddenIds().filter(function(x) { return x !== id; });
        this.hiddenProviders = hide ? hidden.concat([id]) : hidden;
        this.records = this._visibleRecords();
        this._setSetting("hidden-providers", "hiddenProviders", this.hiddenProviders);
    }

    _setGaugeProvider(id) {
        this._setSetting("gauge-provider", "gaugeProvider", id);
    }

    _refreshSeconds() {
        return Math.max(MIN_REFRESH_SECONDS, Number(this.refreshInterval || DEFAULT_REFRESH_SECONDS));
    }

    _hiddenIds() {
        return Array.isArray(this.hiddenProviders) ? this.hiddenProviders : [];
    }

    // ---- views ----

    _currentViewId() {
        return this.panelView || Views.VIEWS[0].id;
    }

    // persist=false keeps auto shuffle from rewriting settings every tick.
    _stepView(step, persist) {
        let slides = this._slides();
        if (slides.length === 0) {
            return;
        }
        let index = Math.max(0, this._slideIndex(slides));
        let next = slides[((index + step) % slides.length + slides.length) % slides.length].id;
        if (persist === false) {
            this.panelView = next;
            this._showSlide();
        } else {
            this._setSetting("panel-view", "panelView", next);
        }
    }

    _slideIndex(slides) {
        let id = this._currentViewId();
        for (let i = 0; i < slides.length; i++) {
            if (slides[i].id === id) {
                return i;
            }
        }
        return -1;
    }

    // Each view has a tag, a value, the percent that drives color/arc, and the window used for the pace tick.
    _slides() {
        if (this.records.length === 0) {
            return [];
        }
        let record = this._gaugeRecord();
        let session = Views.findLimit(record, Views.SESSION_PATTERN);
        let weekly = Views.findLimit(record, Views.WEEKLY_PATTERN);
        let sessionPercent = session ? Number(session.percent || 0) * 100 : this._firstLimitPercent(record);
        let slides = [{ id: "today", tag: "TODAY", text: Format.shortTokens(this._totalTokens()), percent: sessionPercent, window: session ? "5h" : null }];

        if (session) {
            if (session.resetsAt) {
                slides.push({ id: "5h-reset", tag: "5H RESET", text: Format.countdown(session.resetsAt), percent: sessionPercent, window: "5h" });
            }
            slides.push({ id: "5h", tint: true, tag: "5H", text: Math.round(sessionPercent) + "%", percent: sessionPercent, window: "5h" });
            let pace = this._pacePercent(sessionPercent, session);
            if (pace !== null) {
                slides.push({ id: "pace", tint: true, tag: "PACE", text: "~" + Math.round(pace) + "%", percent: Math.min(100, pace), window: null });
            }
        }
        if (weekly) {
            let weeklyPercent = Number(weekly.percent || 0) * 100;
            slides.push({ id: "week", tint: true, tag: "WEEK", text: Math.round(weeklyPercent) + "%", percent: weeklyPercent, window: "week" });
            if (weekly.resetsAt) {
                slides.push({ id: "wk-reset", tag: "WK RESET", text: Format.countdown(weekly.resetsAt), percent: weeklyPercent, window: "week" });
            }
        }
        return slides;
    }

    // Projects 5-hour usage at reset from the burn rate so far; null when too early to tell.
    _pacePercent(percent, session) {
        let elapsed = Views.elapsedFraction(session);
        if (!(percent > 0) || elapsed === null || elapsed < MIN_PACE_ELAPSED) {
            return null;
        }
        return percent / elapsed;
    }

    _slotView(slides, id) {
        for (let i = 0; i < slides.length; i++) {
            if (slides[i].id === id) {
                return slides[i];
            }
        }
        return null;
    }

    _showSlide() {
        let slides = this._slides();
        let record = this._gaugeRecord();
        let session = Views.findLimit(record, Views.SESSION_PATTERN);
        let weekly = Views.findLimit(record, Views.WEEKLY_PATTERN);
        // A middle view without data right now (e.g. pace early in a window) falls back to the first view.
        this.panelState = {
            left: this._slotView(slides, this.slotLeft),
            middle: slides.length > 0 ? slides[Math.max(0, this._slideIndex(slides))] : null,
            right: this._slotView(slides, this.slotRight),
            session: session ? Number(session.percent || 0) * 100 : 0,
            weekly: weekly ? Number(weekly.percent || 0) * 100 : 0,
            sessionElapsed: Views.elapsedFraction(session),
            weeklyElapsed: Views.elapsedFraction(weekly),
            urgent: this._isUrgent(),
            stale: this._staleLevel()
        };
        this._setPanelGauge("normal");
    }

    _isUrgent() {
        return this.records.some(function(record) {
            return (record.limits || []).some(function(limit) { return Number(limit.percent || 0) * 100 >= Render.CRIT_AT; });
        });
    }

    // Data age comes from the collectors' own timestamp, not from when the applet last read the files.
    dataTime() {
        let record = this._gaugeRecord() || this.records[0];
        let time = record ? new Date(record.updatedAt).getTime() : NaN;
        return isNaN(time) ? this.lastUpdated : new Date(time);
    }

    _staleLevel() {
        let time = this.dataTime();
        if (!time) {
            return 0;
        }
        let age = Date.now() - time.getTime();
        return age > VERY_STALE_MS ? 2 : (age > STALE_MS ? 1 : 0);
    }

    isStale() {
        return this._staleLevel() > 0;
    }

    // ---- panel drawing ----

    _setPanelGauge(mode) {
        this.panelGaugeMode = mode;
        let state = mode === "normal" ? this.panelState : {};
        let width = Render.width(state);
        if (this.panelGauge.width !== width) {
            this.panelGauge.set_size(width, Render.HEIGHT);
        }
        let key = JSON.stringify([mode, this._currentDesign(), state.left, state.middle, state.right, state.session, state.weekly,
            Math.floor((state.sessionElapsed || 0) * 100), Math.floor((state.weeklyElapsed || 0) * 100), state.urgent, state.stale]);
        // Skip repaint when nothing visible changed.
        if (key !== this.drawnKey) {
            this.drawnKey = key;
            this.panelGauge.queue_repaint();
        }
        this.set_applet_tooltip(this._tooltip());
    }

    _drawPanelGauge(area) {
        let state = this.panelGaugeMode === "normal" ? this.panelState : {};
        Render.draw(area, Object.assign({}, state, { mode: this.panelGaugeMode, design: this._currentDesign() }));
    }

    _currentDesign() {
        return (this.designShuffle && this.shuffledDesign) || this.design || "arc";
    }

    _tooltip() {
        if (this.records.length === 0) {
            return this.refreshing ? "AI usage: refreshing" : "AI usage: waiting for data";
        }
        let parts = [(this.panelState.urgent ? "! " : "") + "Today: " + Format.shortTokens(this._totalTokens()) + " tokens"];
        this.records.forEach(function(record) {
            let limit = (record.limits || [])[0];
            if (limit) {
                let line = (record.name || record.id) + ": " + Math.round(Number(limit.percent || 0) * 100) + "%";
                parts.push(limit.resetsAt ? line + " · resets in " + Format.countdownLong(limit.resetsAt) : line);
            }
        });
        if (this.isStale()) {
            parts.push("Updated " + Format.ageText(this.dataTime()));
        }
        parts.push("Click: next view · Right-click: details");
        return parts.join("\n");
    }

    // ---- timers ----

    _scheduleCycle() {
        this._clearCycleTimer();
        let seconds = Number(this.cycleSeconds === undefined ? DEFAULT_CYCLE_SECONDS : this.cycleSeconds);
        let shuffle = !!this.autoCycle && seconds > 0;
        let shuffleDesign = !!this.designShuffle && seconds > 0;
        // Without any shuffle the timer only keeps countdowns, pace ticks and staleness current.
        this.cycleTimerId = Mainloop.timeout_add_seconds(shuffle || shuffleDesign ? seconds : TICK_SECONDS, Lang.bind(this, function() {
            if (shuffleDesign) {
                this.shuffledDesign = Views.nextOption(Render.DESIGNS, this._currentDesign(), 1);
            }
            if (shuffle) {
                this._stepView(1, false);
            } else {
                this._showSlide();
            }
            return true;
        }));
    }

    _clearCycleTimer() {
        if (this.cycleTimerId) {
            Mainloop.source_remove(this.cycleTimerId);
            this.cycleTimerId = 0;
        }
    }

    _scheduleRefresh() {
        this._clearRefreshTimer();
        this.lastRefreshSeconds = this._refreshSeconds();
        this.refreshTimerId = Mainloop.timeout_add_seconds(this.lastRefreshSeconds, Lang.bind(this, function() {
            this._refresh(false);
            return true;
        }));
    }

    _clearRefreshTimer() {
        if (this.refreshTimerId) {
            Mainloop.source_remove(this.refreshTimerId);
            this.refreshTimerId = 0;
        }
    }

    _clearWatchdog() {
        if (this.watchdogId) {
            Mainloop.source_remove(this.watchdogId);
            this.watchdogId = 0;
        }
    }

    // ---- data ----

    _refresh(force) {
        if (this.refreshing) {
            return;
        }
        this.refreshing = true;
        let seq = ++this.refreshSeq;
        if (this.menu.isOpen) {
            this._buildMenu();
        }

        let command = (this.updateCommand || DEFAULT_UPDATE_COMMAND).replace(/^~/, GLib.get_home_dir());
        if (force) {
            command += " --force";
        }

        this._clearWatchdog();
        this.watchdogId = Mainloop.timeout_add_seconds(WATCHDOG_SECONDS, Lang.bind(this, function() {
            this.watchdogId = 0;
            this.refreshSeq++;
            this._finishRefresh("updater timed out");
            return false;
        }));

        try {
            Util.spawnCommandLineAsyncIO(command, Lang.bind(this, function(stdout, stderr, exitCode) {
                if (this.removed || seq !== this.refreshSeq) {
                    return;
                }
                this._clearWatchdog();
                this._finishRefresh(exitCode !== 0 ? "updater exit " + exitCode + ": " + String(stderr || "").trim() : null);
            }));
        } catch (e) {
            this._clearWatchdog();
            this._finishRefresh("could not run updater: " + e.message);
        }
    }

    _finishRefresh(problem) {
        if (this.removed) {
            return;
        }
        if (problem) {
            global.logError("ai-usage-meter: " + problem);
        }
        this.refreshing = false;
        this._loadRecords();
    }

    _loadRecords() {
        let records = [];
        let dir = Gio.File.new_for_path(USAGE_DIR);
        if (dir.query_exists(null)) {
            this._scanDir(dir, records);
        }
        this.allRecords = this._sortRecords(records);
        this.records = this._visibleRecords();
        this.lastUpdated = new Date();
        this._onDataChanged();
    }

    _onDataChanged() {
        this._showSlide();
        if (this.menu.isOpen) {
            this._buildMenu();
        }
    }

    _buildMenu() {
        Popup.build(this);
    }

    _scanDir(dir, records) {
        let enumerator = null;
        try {
            enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                if (name.endsWith(".json")) {
                    let record = this._readRecord(USAGE_DIR + "/" + name);
                    if (record) {
                        records.push(record);
                    }
                }
            }
        } catch (e) {
            global.logError("ai-usage-meter: could not read usage dir: " + e.message);
        } finally {
            if (enumerator) {
                enumerator.close(null);
            }
        }
    }

    _readRecord(path) {
        try {
            let [ok, bytes] = GLib.file_get_contents(path);
            let record = JSON.parse(imports.byteArray.toString(bytes));
            return ok && record && typeof record === "object" && record.id ? record : null;
        } catch (e) {
            return null;
        }
    }

    _sortRecords(records) {
        let rank = function(record) {
            let index = ORDER.indexOf(record.id);
            return index < 0 ? ORDER.length : index;
        };
        return records.sort(function(a, b) {
            return rank(a) - rank(b) || String(a.id).localeCompare(String(b.id));
        });
    }

    _visibleRecords() {
        let hidden = this._hiddenIds();
        return this.allRecords.filter(function(record) { return hidden.indexOf(record.id) < 0; });
    }

    // Falls back to the first provider with limits so users without the configured one still get limit views.
    _gaugeRecord() {
        let gauge = this.gaugeProvider || DEFAULT_GAUGE_PROVIDER;
        let fallback = null;
        for (let i = 0; i < this.records.length; i++) {
            let record = this.records[i];
            if ((record.limits || []).length === 0) {
                continue;
            }
            if (record.id === gauge) {
                return record;
            }
            fallback = fallback || record;
        }
        return fallback;
    }

    _firstLimitPercent(record) {
        let limit = record ? (record.limits || [])[0] : null;
        return limit ? Number(limit.percent || 0) * 100 : 0;
    }

    _totalTokens() {
        return this.records.reduce(function(sum, r) { return sum + Number(r.todayTotalTokens || 0); }, 0);
    }

    // Records without local stats (e.g. antigravity) don't carry token counts in recentDays.
    _weekTokens() {
        return this.records.reduce(function(sum, r) {
            let days = r.hasLocalStats === false ? [] : (r.recentDays || []);
            return sum + days.reduce(function(s, d) { return s + Number(d.messageCount || 0); }, 0);
        }, 0);
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new AiUsageMeterApplet(metadata, orientation, panelHeight, instanceId);
}
