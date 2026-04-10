// ==UserScript==
// @name         Gladiatus Bot (v3)
// @version      3.0.0
// @description  Gladiatus automation — refactored for reliability, speed, and proper healing/quest logic
// @author       cansidee
// @match        *://*.gladiatus.gameforge.com/game/index.php*
// @exclude      *://*.gladiatus.gameforge.com/game/index.php?mod=start
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @require      https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js
// @resource     customCSS_global  https://raw.githubusercontent.com/cansidee/gladiatus-script/master/global.css?ver=3.0
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // LOGGER
  // Levels: debug=0  info=1  warn=2  error=3
  // ─────────────────────────────────────────────────────────────
  const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

  const Logger = {
    get minLevel() {
      return LEVEL_ORDER[Store.get('cfg.debugLevel', 'info')] ?? 1;
    },
    _print(level, args) {
      if ((LEVEL_ORDER[level] ?? 99) < this.minLevel) return;
      const tag = `[GBot][${level.toUpperCase()}]`;
      if (level === 'error') console.error(tag, ...args);
      else if (level === 'warn')  console.warn(tag, ...args);
      else                        console.log(tag, ...args);
    },
    debug(...a) { this._print('debug', a); },
    info(...a)  { this._print('info',  a); },
    warn(...a)  { this._print('warn',  a); },
    error(...a) { this._print('error', a); },
  };

  // ─────────────────────────────────────────────────────────────
  // STORE — safe localStorage wrapper (values stored as JSON)
  // ─────────────────────────────────────────────────────────────
  const Store = {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem(key);
        if (v === null) return fallback;
        return JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.error('[GBot][Store] write failed:', key, e);
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch {}
    },
  };

  // ─────────────────────────────────────────────────────────────
  // CONFIG — settings with defaults, persisted via Store
  // ─────────────────────────────────────────────────────────────
  const DEFAULTS = {
    // Bot state
    active:              false,
    language:            'EN',
    debugLevel:          'info',

    // HP thresholds (percent)
    healThreshold:       30,   // enter heal mode below this
    resumeThreshold:     60,   // leave heal mode above this

    // Timing
    delayMin:            900,
    delayMax:            2400,

    // Features
    doExpedition:        true,
    monsterId:           0,
    doDungeon:           true,
    dungeonDifficulty:   'normal',
    doArena:             true,
    arenaOpponentLevel:  'min',
    doCircus:            true,
    circusOpponentLevel: 'min',
    doQuests:            true,
    questTypes:          { combat: true, arena: true, circus: true, expedition: true, dungeon: true, items: true },

    // Quest strategy when no preferred quest is available:
    // 'reroll' — spend a reroll token
    // 'best'   — accept whatever is there
    // 'wait'   — do nothing until cooldown resets
    questStrategy:       'reroll',

    doEventExpedition:   true,
    eventMonsterId:      0,
  };

  const Config = {
    // In-memory cache so we don't JSON.parse on every read
    _c: {},

    get(key) {
      if (key in this._c) return this._c[key];
      const stored = Store.get('cfg.' + key);
      const val = stored !== null ? stored : DEFAULTS[key];
      this._c[key] = val;
      return val;
    },

    set(key, value) {
      this._c[key] = value;
      Store.set('cfg.' + key, value);
    },

    // Wipe cache so next read picks up fresh values
    bust() { this._c = {}; },
  };

  // ─────────────────────────────────────────────────────────────
  // DOM — safe query and mutation helpers
  // ─────────────────────────────────────────────────────────────
  const DOM = {
    qs(sel, root = document) {
      try { return root.querySelector(sel); } catch { return null; }
    },

    qsa(sel, root = document) {
      try { return Array.from(root.querySelectorAll(sel)); } catch { return []; }
    },

    exists(sel, root = document) {
      return this.qs(sel, root) !== null;
    },

    text(sel, root = document) {
      const el = this.qs(sel, root);
      return el ? (el.innerText || el.textContent || '').trim() : '';
    },

    attr(sel, attr, root = document) {
      const el = this.qs(sel, root);
      return el ? el.getAttribute(attr) : null;
    },

    hasClass(el, cls) {
      return !!(el && el.classList && el.classList.contains(cls));
    },

    // Guaranteed-idempotent element insertion — won't create duplicates
    inject(id, tag, html, parent, before = null) {
      if (document.getElementById(id)) return document.getElementById(id);
      const el = document.createElement(tag);
      el.id = id;
      el.innerHTML = html;
      if (before) parent.insertBefore(el, before);
      else parent.appendChild(el);
      return el;
    },

    remove(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    },
  };

  // ─────────────────────────────────────────────────────────────
  // PLAYER — live reads from DOM (not cached at startup)
  // ─────────────────────────────────────────────────────────────
  const Player = {
    get level() {
      const t = DOM.text('#header_values_level');
      return t ? Number(t) : 1;
    },
    get hp() {
      const t = DOM.text('#header_values_hp_percent');
      return t ? Number(t.replace(/[^0-9]/g, '')) : 100;
    },
    get gold() {
      const t = DOM.text('#sstat_gold_val');
      return t ? Number(t.replace(/\./g, '')) : 0;
    },
  };

  // ─────────────────────────────────────────────────────────────
  // PAGE — detection helpers
  // ─────────────────────────────────────────────────────────────
  const Page = {
    get bodyId()  { return document.body ? document.body.id : ''; },
    get params()  { return new URLSearchParams(window.location.search); },
    get mod()     { return this.params.get('mod') || ''; },

    is(id)        { return this.bodyId === id; },
    isQuests()    { return this.is('questsPage'); },
    isLocation()  { return this.is('locationPage'); },
    isDungeon()   { return this.is('dungeonPage'); },
    isArena()     { return this.is('arenaPage'); },
    isHealer()    { return this.mod === 'healer'; },

    // Event expedition: submenu item has class 'glow'
    hasEventExpedition() {
      return DOM.exists('#submenu2 .menuitem.glow');
    },
    isOnEventExpedition() {
      return DOM.exists('#submenu2 .menuitem.active.glow');
    },
  };

  // ─────────────────────────────────────────────────────────────
  // COOLDOWN — read from DOM bar elements
  // ─────────────────────────────────────────────────────────────
  const Cooldown = {
    isReady(fillId) {
      const el = document.getElementById(fillId);
      return el ? el.classList.contains('cooldown_bar_fill_ready') : false;
    },

    // Parse "H:MM:SS" text from a cooldown bar label into milliseconds
    remainingMs(textId) {
      const el = document.getElementById(textId);
      if (!el) return Infinity;
      return this._hmsToMs((el.innerText || el.textContent || '').trim());
    },

    // Read data-ticker-time-left (server-provided ms) from a querySelector match
    tickerMs(sel) {
      const el = DOM.qs(sel);
      if (!el) return null;
      const v = el.getAttribute('data-ticker-time-left');
      return v !== null ? Number(v) : null;
    },

    _hmsToMs(t) {
      const parts = t.split(':');
      if (parts.length !== 3) return Infinity;
      const h = Number(parts[0]), m = Number(parts[1]), s = Number(parts[2]);
      if ([h, m, s].some(isNaN)) return Infinity;
      return (h * 3600 + m * 60 + s) * 1000;
    },
  };

  // ─────────────────────────────────────────────────────────────
  // TIMER — one active timer, one active interval, safely managed
  // ─────────────────────────────────────────────────────────────
  const Timer = {
    _tid:  null,
    _iid:  null,

    schedule(fn, ms) {
      this.cancelTimer();
      this._tid = setTimeout(fn, ms);
    },

    loop(fn, ms) {
      this.cancelLoop();
      this._iid = setInterval(fn, ms);
    },

    cancelTimer() {
      if (this._tid !== null) { clearTimeout(this._tid);  this._tid = null; }
    },

    cancelLoop() {
      if (this._iid !== null) { clearInterval(this._iid); this._iid = null; }
    },

    cancelAll() {
      this.cancelTimer();
      this.cancelLoop();
    },
  };

  // ─────────────────────────────────────────────────────────────
  // Utility helpers
  // ─────────────────────────────────────────────────────────────
  function randDelay() {
    const lo = Config.get('delayMin');
    const hi = Config.get('delayMax');
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function formatTime(ms) {
    if (ms <= 0) return '0:00:00';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function serverDateString() {
    const el = DOM.qs('#server-time');
    return el ? (el.innerHTML || '').split(',')[0].trim() : new Date().toDateString();
  }

  // ─────────────────────────────────────────────────────────────
  // ENGINE — priority-based action loop
  // ─────────────────────────────────────────────────────────────
  const Engine = {
    _running:        false,
    _healingMode:    false,
    _healRetries:    0,
    MAX_HEAL_RETRIES: 5,

    get running() { return this._running; },

    start() {
      this._running = true;
      Config.set('active', true);
      UI.syncButton();
      Logger.info('Bot started');
      this.tick();
    },

    stop() {
      this._running = false;
      Config.set('active', false);
      Timer.cancelAll();
      UI.removeOverlays();
      UI.syncButton();
      Logger.info('Bot stopped');
    },

    // Schedule next tick with a delay
    schedule(ms) {
      if (!this._running) return;
      Timer.cancelTimer(); // always cancel previous before scheduling
      Timer.schedule(() => this.tick(), ms);
    },

    // Central dispatcher — runs on each tick
    tick() {
      if (!this._running) return;

      const delay = randDelay();

      // P0: Dismiss modal dialogs (login bonus, notifications)
      if (this._tryDismissDialogs(delay)) return;

      // P1: Low HP — override everything and heal
      const hp = Player.hp;
      const healThr = Config.get('healThreshold');
      const resumeThr = Config.get('resumeThreshold');

      if (this._healingMode) {
        if (hp >= resumeThr) {
          Logger.info(`HP ${hp}% — healed. Resuming.`);
          this._healingMode = false;
          this._healRetries = 0;
          UI.removeHealingAlert();
          this.schedule(delay);
        } else {
          this._doHealCycle(delay);
        }
        return;
      }

      if (hp > 0 && hp < healThr) {
        Logger.warn(`HP ${hp}% below threshold ${healThr}%. Entering heal mode.`);
        this._healingMode = true;
        this._healRetries = 0;
        UI.showHealingAlert(hp);
        this._doHealCycle(delay);
        return;
      }

      // P2: Quests (highest frequency, short cooldown)
      if (Config.get('doQuests') && Store.get('nextQuestTime', 0) < Date.now()) {
        Logger.info('Tick → quests');
        Timer.schedule(() => Actions.quests(() => this.schedule(delay)), delay);
        return;
      }

      // P3: Expedition
      if (Config.get('doExpedition') && Cooldown.isReady('cooldown_bar_fill_expedition')) {
        Logger.info('Tick → expedition');
        Timer.schedule(() => Actions.expedition(() => this.schedule(delay)), delay);
        return;
      }

      // P4: Dungeon (level gate: 10)
      if (Config.get('doDungeon') && Player.level >= 10 && Cooldown.isReady('cooldown_bar_fill_dungeon')) {
        Logger.info('Tick → dungeon');
        Timer.schedule(() => Actions.dungeon(() => this.schedule(delay)), delay);
        return;
      }

      // P5: Arena (level gate: 2)
      if (Config.get('doArena') && Player.level >= 2 && Cooldown.isReady('cooldown_bar_fill_arena')) {
        Logger.info('Tick → arena');
        Timer.schedule(() => Actions.arena(() => this.schedule(delay + 600)), delay + 600);
        return;
      }

      // P6: Circus (level gate: 10)
      if (Config.get('doCircus') && Player.level >= 10 && Cooldown.isReady('cooldown_bar_fill_ct')) {
        Logger.info('Tick → circus');
        Timer.schedule(() => Actions.circus(() => this.schedule(delay + 600)), delay + 600);
        return;
      }

      // P7: Event expedition
      const evPts = this._eventPoints();
      const evNext = Store.get('nextEventExpeditionTime', 0);
      if (Config.get('doEventExpedition') && Page.hasEventExpedition() && evPts > 0 && evNext < Date.now()) {
        Logger.info('Tick → event expedition');
        Timer.schedule(() => Actions.eventExpedition(() => this.schedule(delay)), delay);
        return;
      }

      // Nothing ready — compute wait and show countdown
      this._waitForNext();
    },

    // ── Healing cycle (called repeatedly until HP recovers) ──
    _doHealCycle(delay) {
      if (this._healRetries >= this.MAX_HEAL_RETRIES) {
        Logger.warn('Max heal retries reached. Waiting 2 min before retrying.');
        this._healRetries = 0;
        UI.showHealingAlert(Player.hp, true);
        this.schedule(120_000);
        return;
      }
      this._healRetries++;
      UI.showHealingAlert(Player.hp);
      Timer.schedule(() => Actions.healer(() => this.schedule(5000)), delay);
    },

    // ── Dismiss blocking dialogs ──
    _tryDismissDialogs(delay) {
      // Login bonus popup
      const loginBonus = document.getElementById('blackoutDialogLoginBonus');
      if (loginBonus) {
        const btn = loginBonus.querySelector('input[type=submit], input[type=button], button');
        if (btn) {
          Logger.info('Dismissing login bonus');
          Timer.schedule(() => { btn.click(); this.schedule(delay); }, delay);
          return true;
        }
      }

      // Notification popup — check visibility via style/class, not .isDisplayed()
      const notif = document.getElementById('blackoutDialognotification');
      if (notif) {
        const style = window.getComputedStyle(notif);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const btn = notif.querySelector('input[type=submit], input[type=button], button');
          if (btn) {
            Logger.info('Dismissing notification');
            Timer.schedule(() => { btn.click(); this.schedule(delay); }, delay);
            return true;
          }
        }
      }

      return false;
    },

    // ── Wait and countdown to next ready action ──
    _waitForNext() {
      Timer.cancelAll();
      UI.removeOverlays();

      const candidates = this._buildCandidateList();

      if (!candidates.length) {
        Logger.info('No actions enabled — sleeping 5 min');
        UI.showNextAction('—', 300_000);
        this.schedule(300_000);
        return;
      }

      candidates.sort((a, b) => a.ms - b.ms);
      const next = candidates[0];
      Logger.info(`Waiting for [${next.name}] in ${formatTime(next.ms)}`);

      UI.showNextAction(next.name, next.ms);

      let remaining = next.ms;
      Timer.loop(() => {
        remaining -= 1000;
        UI.updateCountdown(remaining);
        if (remaining <= 0) {
          Timer.cancelAll();
          UI.removeOverlays();
          this.tick();
        }
      }, 1000);
    },

    _buildCandidateList() {
      const list = [];

      if (Config.get('doExpedition')) {
        const ms = Cooldown.remainingMs('cooldown_bar_text_expedition');
        if (ms < Infinity) list.push({ name: 'Expedition', ms });
      }
      if (Config.get('doDungeon') && Player.level >= 10) {
        const ms = Cooldown.remainingMs('cooldown_bar_text_dungeon');
        if (ms < Infinity) list.push({ name: 'Dungeon', ms });
      }
      if (Config.get('doArena') && Player.level >= 2) {
        const ms = Cooldown.remainingMs('cooldown_bar_text_arena');
        if (ms < Infinity) list.push({ name: 'Arena', ms });
      }
      if (Config.get('doCircus') && Player.level >= 10) {
        const ms = Cooldown.remainingMs('cooldown_bar_text_ct');
        if (ms < Infinity) list.push({ name: 'Circus', ms });
      }
      if (Config.get('doQuests')) {
        const ms = Math.max(0, Store.get('nextQuestTime', 0) - Date.now());
        list.push({ name: 'Quests', ms });
      }
      if (Config.get('doEventExpedition') && Page.hasEventExpedition() && this._eventPoints() > 0) {
        const ms = Math.max(0, Store.get('nextEventExpeditionTime', 0) - Date.now());
        list.push({ name: 'Event Expedition', ms });
      }

      return list;
    },

    _eventPoints() {
      const saved = Store.get('eventPoints', null);
      if (saved && saved.date === serverDateString()) return Number(saved.count) || 0;
      return 16;
    },
  };

  // ─────────────────────────────────────────────────────────────
  // ACTIONS — each handles its own page detection + navigation
  // ─────────────────────────────────────────────────────────────
  const Actions = {

    // ──────────────────────────────────────────────────────────
    // HEALER
    // Navigates to healer page if needed, then clicks heal button.
    //
    // DOM assumptions (isolated for easy maintenance):
    //   Navigation:  a[href*="mod=healer"] or URL fallback to ?mod=healer
    //   Heal button: #heal_button, input[name*="heal"], .button1 (on healer page)
    //   No-money:    .error-message, [class*="not-enough"]
    // ──────────────────────────────────────────────────────────
    healer(done) {
      if (!Page.isHealer()) {
        // Try to find healer link in navigation
        const link =
          DOM.qs('a[href*="mod=healer"]') ||
          DOM.qs('#submenu a[href*="healer"]') ||
          DOM.qs('.city-healer-link');

        if (link) {
          Logger.info('Navigating to healer via link');
          link.click();
        } else {
          Logger.info('Navigating to healer via URL');
          const base = window.location.href.split('?')[0];
          window.location.href = base + '?mod=healer';
        }
        // Page will reload — Engine will resume automatically on next load
        return;
      }

      // We're on the healer page
      // Try common heal button selectors
      const healBtn =
        DOM.qs('#heal_button') ||
        DOM.qs('input[name*="heal"]') ||
        DOM.qs('input[value*="eal"]') ||  // "Heal" or "Heilen" etc.
        DOM.qs('a[href*="heal_all"]') ||
        DOM.qs('.heal-button') ||
        DOM.qs('form[action*="healer"] .button1') ||
        DOM.qs('form[action*="healer"] input[type=submit]');

      if (healBtn) {
        Logger.info('Clicking heal button');
        healBtn.click();
        // After click, page reloads — hp will be re-read on next tick
      } else {
        // Check if we can't afford healing
        const errEl = DOM.qs('.error-message, [class*="not-enough"], .healer-no-gold');
        if (errEl) {
          Logger.warn('Cannot afford healing (no gold):', errEl.textContent.trim());
        } else {
          Logger.warn('Heal button not found — update healer selectors if game DOM changed');
        }
      }

      done();
    },

    // ──────────────────────────────────────────────────────────
    // QUESTS
    // Priority order:
    //   1. Complete finished quests
    //   2. Restart failed quests
    //   3. Accept new preferred quest
    //   4. Reroll / wait / best (based on questStrategy setting)
    //   5. Record cooldown and return
    // ──────────────────────────────────────────────────────────
    quests(done) {
      if (!Page.isQuests()) {
        // Navigate to quests page — it's the 2nd mainmenu link
        const links = DOM.qsa('#mainmenu a.menuitem');
        if (links[1]) {
          Logger.info('Navigating to quests page');
          links[1].click();
        } else {
          Logger.warn('Quest menu link not found — skipping quests for 1 min');
          Store.set('nextQuestTime', Date.now() + 60_000);
          done();
        }
        return;
      }

      // 1. Complete finished quests
      const finishBtn = DOM.qs('#content .contentboard_slot a.quest_slot_button_finish');
      if (finishBtn) {
        Logger.info('Completing finished quest');
        finishBtn.click();
        // Page reloads — next tick will continue with remaining finished quests
        return;
      }

      // 2. Restart failed quests
      const restartBtn = DOM.qs('#content .contentboard_slot a.quest_slot_button_restart');
      if (restartBtn) {
        Logger.info('Restarting failed quest');
        restartBtn.click();
        return;
      }

      // 3. Find open accept slots
      const acceptSlots = DOM.qsa('#content .contentboard_slot a.quest_slot_button_accept');
      if (acceptSlots.length) {
        this._acceptQuest(done);
        return;
      }

      // 4. No action possible — check cooldown and record it
      this._recordQuestCooldown(done);
    },

    _acceptQuest(done) {
      const questTypes = Config.get('questTypes');

      // Map all inactive slots to icon type
      const slots = DOM.qsa('#content .contentboard_slot_inactive');
      for (const slot of slots) {
        const iconEl = slot.querySelector('.quest_slot_icon');
        if (!iconEl) continue;

        // Extract icon name from background-image URL: "icon_expedition_inactive" → "expedition"
        const bg = iconEl.style.backgroundImage || '';
        const m  = bg.match(/icon_([a-z]+?)(?:_inactive)?["')]/i);
        if (!m) continue;

        let icon = m[1].toLowerCase();
        if (icon === 'grouparena') icon = 'circus';

        if (questTypes[icon]) {
          const btn = slot.querySelector('.quest_slot_button_accept');
          if (btn) {
            Logger.info(`Accepting quest type: ${icon}`);
            btn.click();
            return;
          }
        }
      }

      // No preferred quest available — apply strategy
      const strategy = Config.get('questStrategy');
      Logger.info(`No preferred quest. Strategy: ${strategy}`);

      if (strategy === 'reroll') {
        const rerollBtn = DOM.qs('#quest_footer_reroll input');
        if (rerollBtn) {
          Logger.info('Rerolling quests');
          rerollBtn.click();
          return;
        }
        Logger.warn('Reroll button not found — falling back to wait');
      }

      if (strategy === 'best') {
        // Accept first available quest regardless of type
        const firstSlot = DOM.qs('#content .contentboard_slot_inactive .quest_slot_button_accept');
        if (firstSlot) {
          Logger.info('Accepting best-available quest');
          firstSlot.click();
          return;
        }
      }

      // strategy === 'wait' or nothing worked
      this._recordQuestCooldown(done);
    },

    _recordQuestCooldown(done) {
      // Prefer server-supplied ticker value (most accurate)
      const tickerMs = Cooldown.tickerMs('#quest_header_cooldown b span[data-ticker-time-left]');

      let next;
      if (tickerMs !== null && tickerMs > 0) {
        next = Date.now() + tickerMs;
        Logger.info(`Quest cooldown: ${formatTime(tickerMs)}`);
      } else {
        // Fallback: wait 5 minutes
        next = Date.now() + 300_000;
        Logger.info('Quest cooldown unknown — waiting 5 min');
      }

      Store.set('nextQuestTime', next);
      done();
    },

    // ──────────────────────────────────────────────────────────
    // EXPEDITION
    // ──────────────────────────────────────────────────────────
    expedition(done) {
      if (!Page.isLocation()) {
        // Find the expedition cooldown bar's link
        const link = this._findCooldownLink('expedition') || DOM.qsa('.cooldown_bar_link')[0];
        if (link) {
          Logger.info('Navigating to expedition');
          link.click();
        } else {
          Logger.warn('Expedition nav link not found');
          done();
        }
        return;
      }

      // We are on the expedition/location page
      // Guard against landing on an event expedition page
      if (Page.isOnEventExpedition()) {
        Logger.info('On event expedition page — navigating back');
        window.history.back();
        return;
      }

      const id      = Number(Config.get('monsterId'));
      const buttons = DOM.qsa('.expedition_button');

      if (buttons[id]) {
        Logger.info(`Expedition: attacking monster slot ${id}`);
        buttons[id].click();
      } else if (buttons.length) {
        Logger.warn(`Monster slot ${id} not found — using slot 0`);
        buttons[0].click();
      } else {
        Logger.warn('No expedition buttons found');
        done();
      }
    },

    // ──────────────────────────────────────────────────────────
    // DUNGEON
    // ──────────────────────────────────────────────────────────
    dungeon(done) {
      if (!Page.isDungeon()) {
        const link = this._findCooldownLink('dungeon') || DOM.qsa('.cooldown_bar_link')[1];
        if (link) {
          Logger.info('Navigating to dungeon');
          link.click();
        } else {
          Logger.warn('Dungeon nav link not found');
          done();
        }
        return;
      }

      // Detect which sub-page we're on:
      // If <area> elements exist → we're on the dungeon map (ready to enter)
      // If not → we're on the difficulty selection screen
      const mapArea = DOM.qs('#content area');

      if (!mapArea) {
        // Difficulty selection
        const diff    = Config.get('dungeonDifficulty');
        const buttons = DOM.qsa('#content .button1');
        const idx     = diff === 'advanced' ? 1 : 0;
        const btn     = buttons[idx] || buttons[0];

        if (btn) {
          Logger.info(`Selecting dungeon difficulty: ${diff}`);
          btn.click();
        } else {
          Logger.warn('Dungeon difficulty buttons not found');
          done();
        }
      } else {
        Logger.info('Entering dungeon');
        mapArea.click();
      }
    },

    // ──────────────────────────────────────────────────────────
    // ARENA
    // ──────────────────────────────────────────────────────────
    arena(done) {
      if (!Page.isArena()) {
        // Arena is cooldown_bar_link index 2 for level >= 10, 1 for level < 10
        const link = this._findCooldownLink('arena')
          || DOM.qsa('.cooldown_bar_link')[Player.level < 10 ? 1 : 2];
        if (link) {
          Logger.info('Navigating to arena');
          link.click();
        } else {
          Logger.warn('Arena nav link not found');
          done();
        }
        return;
      }

      // Ensure Provinciarum tab is active (tab inside #own2)
      // Use querySelector + classList — not jQuery .hasClass on a raw node
      const provTabContent = document.getElementById('own2');
      if (!provTabContent || getComputedStyle(provTabContent).display === 'none') {
        // Click the Provinciarum tab header — typically td[1] firstElementChild
        const tab = DOM.qs('td:nth-child(2) > .awesome-tabs');
        if (tab && !tab.classList.contains('current')) {
          Logger.info('Activating Provinciarum tab');
          tab.click();
          return;
        }
      }

      const levels     = this._extractLevels('#own2');
      const attackBtns = DOM.qsa('#own2 .attack, #own2 a[href*="fight"]');

      if (!levels.length || !attackBtns.length) {
        Logger.warn('Arena: no opponents found');
        done();
        return;
      }

      const idx = this._pickIndex(levels, Config.get('arenaOpponentLevel'));
      if (attackBtns[idx]) {
        Logger.info(`Arena: attacking opponent ${idx} (level ${levels[idx]})`);
        attackBtns[idx].click();
      } else {
        Logger.warn(`Arena: attack button at index ${idx} not found`);
        done();
      }
    },

    // ──────────────────────────────────────────────────────────
    // CIRCUS
    // ──────────────────────────────────────────────────────────
    circus(done) {
      if (!Page.isArena()) {
        const link = this._findCooldownLink('ct')
          || this._findCooldownLink('circus')
          || DOM.qsa('.cooldown_bar_link')[3];
        if (link) {
          Logger.info('Navigating to circus');
          link.click();
        } else {
          Logger.warn('Circus nav link not found');
          done();
        }
        return;
      }

      // Ensure Circus Turma tab is active (#own3)
      const circusContent = document.getElementById('own3');
      if (!circusContent || getComputedStyle(circusContent).display === 'none') {
        const tab = DOM.qs('td:nth-child(4) > .awesome-tabs');
        if (tab && !tab.classList.contains('current')) {
          Logger.info('Activating Circus Turma tab');
          tab.click();
          return;
        }
      }

      const levels     = this._extractLevels('#own3');
      const attackBtns = DOM.qsa('#own3 .attack, #own3 a[href*="fight"]');

      if (!levels.length || !attackBtns.length) {
        Logger.warn('Circus: no opponents found');
        done();
        return;
      }

      const idx = this._pickIndex(levels, Config.get('circusOpponentLevel'));
      if (attackBtns[idx]) {
        Logger.info(`Circus: attacking opponent ${idx} (level ${levels[idx]})`);
        attackBtns[idx].click();
      } else {
        Logger.warn(`Circus: attack button at index ${idx} not found`);
        done();
      }
    },

    // ──────────────────────────────────────────────────────────
    // EVENT EXPEDITION
    // ──────────────────────────────────────────────────────────
    eventExpedition(done) {
      const today  = serverDateString();
      const saved  = Store.get('eventPoints', null);
      let pts      = (saved && saved.date === today) ? Number(saved.count) : 16;

      if (!Page.isOnEventExpedition()) {
        const link = DOM.qs('#submenu2 .menuitem.glow');
        if (link) {
          Logger.info('Navigating to event expedition');
          link.click();
        } else {
          Logger.warn('Event expedition link not found');
          done();
        }
        return;
      }

      // Re-read live point count from page DOM
      const ptEl = DOM.qs('#content .section-header p:nth-child(2)');
      if (ptEl) {
        const raw = (ptEl.firstChild?.nodeValue || ptEl.textContent || '').replace(/[^0-9]/g, '');
        if (raw) pts = Number(raw);
        Store.set('eventPoints', { count: pts, date: today });
      }

      // Check if a cooldown timer is active before attacking
      const timerEl = DOM.qs('#content .ticker[data-ticker-time-left]');
      if (timerEl) {
        const ms = Number(timerEl.getAttribute('data-ticker-time-left')) || 0;
        Logger.info(`Event expedition on cooldown: ${formatTime(ms)}`);
        Store.set('nextEventExpeditionTime', Date.now() + ms);
        location.reload();
        return;
      }

      if (pts <= 0) {
        Logger.info('No event expedition points left today');
        location.reload();
        return;
      }

      const mId     = Number(Config.get('eventMonsterId'));
      const buttons = DOM.qsa('.expedition_button');
      const isBoss  = mId === 3;
      const cost    = isBoss ? 2 : 1;

      // Boss requires 2 points — fall back to slot 2 if only 1 point left
      const effectiveId = (isBoss && pts < 2) ? 2 : mId;
      const btn = buttons[effectiveId] || buttons[0];

      if (!btn) {
        Logger.warn('Event expedition: no buttons found');
        done();
        return;
      }

      Logger.info(`Event expedition: attacking slot ${effectiveId} (cost ${effectiveId === 3 ? 2 : 1} pts, remaining ${pts})`);
      Store.set('eventPoints',            { count: pts - (effectiveId === 3 ? 2 : 1), date: today });
      Store.set('nextEventExpeditionTime', Date.now() + 303_000);
      btn.click();
    },

    // ── Shared helpers ──

    // Find cooldown bar link that navigates to a specific section by href keyword
    _findCooldownLink(keyword) {
      return DOM.qsa('.cooldown_bar_link').find(l => (l.href || '').toLowerCase().includes(keyword)) || null;
    },

    // Extract opponent levels from arena/circus tables
    // Layout: each opponent spans 4 <td> cells; level is in td[1], td[5], td[9]...
    _extractLevels(tableSelector) {
      const tds    = DOM.qsa(`${tableSelector} td`);
      const levels = [];
      for (let i = 1; i < tds.length && levels.length < 5; i += 4) {
        const raw = (tds[i]?.firstChild?.nodeValue || tds[i]?.textContent || '').trim();
        const v   = Number(raw);
        if (v > 0) levels.push(v);
      }
      return levels;
    },

    _pickIndex(levels, preference) {
      if (preference === 'min') return levels.indexOf(Math.min(...levels));
      if (preference === 'max') return levels.indexOf(Math.max(...levels));
      return Math.floor(Math.random() * levels.length);
    },
  };

  // ─────────────────────────────────────────────────────────────
  // UI — overlays, buttons, settings panel
  // ─────────────────────────────────────────────────────────────
  const UI = {
    init() {
      try { GM_addStyle(GM_getResourceText('customCSS_global')); } catch {}
      this._injectStartButton();
      this._injectSettingsButton();
    },

    // ── Start/Stop button ──
    _injectStartButton() {
      if (document.getElementById('autoGoButton')) return;
      const btn    = document.createElement('button');
      btn.id       = 'autoGoButton';
      btn.className = 'menuitem';
      btn.style.cssText = 'cursor:pointer;font-weight:bold;min-width:60px;';
      btn.textContent = Engine.running ? 'DUR' : 'Baslat';
      btn.addEventListener('click', () => {
        if (Engine.running) Engine.stop(); else Engine.start();
        this.syncButton();
      });
      const menu = document.getElementById('mainmenu');
      if (menu) menu.insertBefore(btn, menu.firstElementChild);
    },

    syncButton() {
      const btn = document.getElementById('autoGoButton');
      if (btn) btn.textContent = Engine.running ? 'DUR' : 'Baslat';
    },

    // ── Settings button ──
    _injectSettingsButton() {
      if (document.getElementById('settingsOpenBtn')) return;
      const btn    = document.createElement('button');
      btn.id       = 'settingsOpenBtn';
      btn.className = 'menuitem';
      btn.title    = 'Bot Settings';
      btn.textContent = '⚙';
      btn.style.cssText = 'cursor:pointer;font-size:14px;padding:0 5px;';
      btn.addEventListener('click', () => Settings.open());
      const menu = document.getElementById('mainmenu');
      if (menu && menu.children[1]) menu.insertBefore(btn, menu.children[1]);
      else if (menu) menu.appendChild(btn);
    },

    // ── Next-action overlay ──
    showNextAction(name, ms) {
      this.removeHealingAlert();
      let el = document.getElementById('nextActionWindow');
      if (!el) {
        el = document.createElement('div');
        el.id = 'nextActionWindow';
        el.style.cssText = `
          position:absolute;top:120px;left:506px;width:365px;padding:13px 0;
          color:#58ffbb;background:#000000db;font-size:20px;text-align:center;
          border-radius:20px;border-left:10px solid #58ffbb;border-right:10px solid #58ffbb;z-index:999;`;
        const hg = document.getElementById('header_game');
        if (hg) hg.insertBefore(el, hg.firstElementChild);
      }
      el.innerHTML = `<span style="color:#fff">Next: </span><b>${name}</b><br>
        <span style="color:#fff">In: </span><span id="nadCountdown">${formatTime(ms)}</span>`;
    },

    updateCountdown(ms) {
      const el = document.getElementById('nadCountdown');
      if (el) el.textContent = formatTime(ms);
    },

    // ── Healing alert overlay ──
    showHealingAlert(hp, waiting = false) {
      DOM.remove('nextActionWindow');
      let el = document.getElementById('healingAlert');
      if (!el) {
        el = document.createElement('div');
        el.id = 'healingAlert';
        el.style.cssText = `
          position:absolute;top:120px;left:506px;width:365px;padding:20px 0;
          color:#ea1414;background:#000000db;font-size:20px;text-align:center;
          border-radius:25px;border-left:10px solid #ea1414;border-right:10px solid #ea1414;z-index:999;`;
        const hg = document.getElementById('header_game');
        if (hg) hg.insertBefore(el, hg.firstElementChild);
      }
      el.innerHTML = waiting
        ? `<b>Low HP (${hp}%)</b><br><span style="font-size:14px">Waiting for gold to heal...</span>`
        : `<b>Low HP (${hp}%)</b><br><span style="font-size:14px">Going to healer...</span>`;
    },

    removeHealingAlert() { DOM.remove('healingAlert'); },
    removeOverlays()     { DOM.remove('nextActionWindow'); DOM.remove('healingAlert'); },
  };

  // ─────────────────────────────────────────────────────────────
  // SETTINGS PANEL
  // ─────────────────────────────────────────────────────────────
  const Settings = {
    open() {
      if (document.getElementById('settingsWindow')) return; // idempotent

      const overlay = document.createElement('div');
      overlay.id    = 'overlayBack';
      overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;`;
      overlay.addEventListener('click', () => this.close());
      document.body.appendChild(overlay);

      const win = document.createElement('div');
      win.id    = 'settingsWindow';
      win.style.cssText = `
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        background:#111;color:#ccc;padding:20px;border-radius:12px;
        z-index:1001;min-width:480px;max-height:80vh;overflow-y:auto;
        font-family:sans-serif;font-size:13px;`;
      win.innerHTML = this._html();
      document.body.appendChild(win);

      this._wire(win);
      this._highlight(win);
    },

    close() {
      DOM.remove('settingsWindow');
      DOM.remove('overlayBack');
    },

    _html() {
      return `
        <h2 style="margin:0 0 12px;color:#58ffbb;font-size:16px;">⚙ Bot Settings</h2>

        <div class="s-section">
          <b>HP Thresholds</b>
          <label>Heal below: <input id="s-healThr" type="number" min="1" max="99" value="${Config.get('healThreshold')}">%</label>
          <label>Resume above: <input id="s-resumeThr" type="number" min="1" max="99" value="${Config.get('resumeThreshold')}">%</label>
        </div>

        <div class="s-section">
          <b>Action Delays</b>
          <label>Min delay: <input id="s-delayMin" type="number" min="300" max="5000" value="${Config.get('delayMin')}"> ms</label>
          <label>Max delay: <input id="s-delayMax" type="number" min="300" max="5000" value="${Config.get('delayMax')}"> ms</label>
        </div>

        <div class="s-section">
          <b>Expedition</b>
          <label><input type="checkbox" id="s-doExp" ${Config.get('doExpedition') ? 'checked' : ''}> Enabled</label>
          <label>Monster slot:
            <select id="s-monsterId">
              <option value="0" ${Config.get('monsterId') == 0 ? 'selected':''}>1</option>
              <option value="1" ${Config.get('monsterId') == 1 ? 'selected':''}>2</option>
              <option value="2" ${Config.get('monsterId') == 2 ? 'selected':''}>3</option>
              <option value="3" ${Config.get('monsterId') == 3 ? 'selected':''}>Boss</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Dungeon</b>
          <label><input type="checkbox" id="s-doDun" ${Config.get('doDungeon') ? 'checked' : ''}> Enabled</label>
          <label>Difficulty:
            <select id="s-dungeonDiff">
              <option value="normal"   ${Config.get('dungeonDifficulty') === 'normal'   ? 'selected':''}>Normal</option>
              <option value="advanced" ${Config.get('dungeonDifficulty') === 'advanced' ? 'selected':''}>Advanced</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Arena</b>
          <label><input type="checkbox" id="s-doArena" ${Config.get('doArena') ? 'checked' : ''}> Enabled</label>
          <label>Opponent:
            <select id="s-arenaLevel">
              <option value="min"    ${Config.get('arenaOpponentLevel') === 'min'    ? 'selected':''}>Lowest</option>
              <option value="max"    ${Config.get('arenaOpponentLevel') === 'max'    ? 'selected':''}>Highest</option>
              <option value="random" ${Config.get('arenaOpponentLevel') === 'random' ? 'selected':''}>Random</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Circus Turma</b>
          <label><input type="checkbox" id="s-doCircus" ${Config.get('doCircus') ? 'checked' : ''}> Enabled</label>
          <label>Opponent:
            <select id="s-circusLevel">
              <option value="min"    ${Config.get('circusOpponentLevel') === 'min'    ? 'selected':''}>Lowest</option>
              <option value="max"    ${Config.get('circusOpponentLevel') === 'max'    ? 'selected':''}>Highest</option>
              <option value="random" ${Config.get('circusOpponentLevel') === 'random' ? 'selected':''}>Random</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Quests</b>
          <label><input type="checkbox" id="s-doQuests" ${Config.get('doQuests') ? 'checked' : ''}> Enabled</label>
          <label>Strategy when no preferred quest:
            <select id="s-questStrategy">
              <option value="reroll" ${Config.get('questStrategy') === 'reroll' ? 'selected':''}>Reroll</option>
              <option value="best"   ${Config.get('questStrategy') === 'best'   ? 'selected':''}>Accept best</option>
              <option value="wait"   ${Config.get('questStrategy') === 'wait'   ? 'selected':''}>Wait</option>
            </select>
          </label>
          <div style="margin-top:6px"><b>Quest types:</b></div>
          ${this._questTypeCheckboxes()}
        </div>

        <div class="s-section">
          <b>Event Expedition</b>
          <label><input type="checkbox" id="s-doEvent" ${Config.get('doEventExpedition') ? 'checked' : ''}> Enabled</label>
          <label>Monster slot:
            <select id="s-eventMonster">
              <option value="0" ${Config.get('eventMonsterId') == 0 ? 'selected':''}>1</option>
              <option value="1" ${Config.get('eventMonsterId') == 1 ? 'selected':''}>2</option>
              <option value="2" ${Config.get('eventMonsterId') == 2 ? 'selected':''}>3</option>
              <option value="3" ${Config.get('eventMonsterId') == 3 ? 'selected':''}>Boss</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Debug</b>
          <label>Log level:
            <select id="s-debugLevel">
              <option value="debug" ${Config.get('debugLevel') === 'debug' ? 'selected':''}>Debug</option>
              <option value="info"  ${Config.get('debugLevel') === 'info'  ? 'selected':''}>Info</option>
              <option value="warn"  ${Config.get('debugLevel') === 'warn'  ? 'selected':''}>Warn</option>
              <option value="error" ${Config.get('debugLevel') === 'error' ? 'selected':''}>Error</option>
            </select>
          </label>
        </div>

        <div style="text-align:right;margin-top:14px">
          <button id="s-save"  style="margin-right:8px;padding:6px 14px;cursor:pointer;">Save</button>
          <button id="s-close" style="padding:6px 14px;cursor:pointer;">Cancel</button>
        </div>

        <style>
          .s-section { margin-bottom:12px;padding:8px;background:#1a1a1a;border-radius:6px; }
          .s-section b { display:block;margin-bottom:6px;color:#58ffbb; }
          .s-section label { display:block;margin:3px 0; }
          .s-section input[type=number], .s-section select { margin-left:6px;background:#222;color:#ccc;border:1px solid #444;border-radius:3px;padding:2px 4px; }
          .s-qt { display:inline-flex;gap:4px;flex-wrap:wrap;margin-top:4px; }
          .s-qt label { background:#222;padding:3px 8px;border-radius:4px;cursor:pointer;border:1px solid #444; }
          .s-qt input:checked + span { color:#58ffbb; }
        </style>`;
    },

    _questTypeCheckboxes() {
      const types  = Config.get('questTypes');
      const labels = { combat: 'Combat', arena: 'Arena', circus: 'Circus', expedition: 'Expedition', dungeon: 'Dungeon', items: 'Items' };
      return '<div class="s-qt">' +
        Object.entries(labels).map(([k, v]) =>
          `<label><input type="checkbox" class="s-qt-cb" data-type="${k}" ${types[k] ? 'checked' : ''}><span> ${v}</span></label>`
        ).join('') +
        '</div>';
    },

    _wire(win) {
      win.querySelector('#s-save').addEventListener('click', () => {
        const g  = id => win.querySelector('#' + id);
        const gi = id => Number(g(id).value);
        const gb = id => g(id).checked;
        const gs = id => g(id).value;

        Config.set('healThreshold',       gi('s-healThr'));
        Config.set('resumeThreshold',     gi('s-resumeThr'));
        Config.set('delayMin',            gi('s-delayMin'));
        Config.set('delayMax',            gi('s-delayMax'));
        Config.set('doExpedition',        gb('s-doExp'));
        Config.set('monsterId',           gi('s-monsterId'));
        Config.set('doDungeon',           gb('s-doDun'));
        Config.set('dungeonDifficulty',   gs('s-dungeonDiff'));
        Config.set('doArena',             gb('s-doArena'));
        Config.set('arenaOpponentLevel',  gs('s-arenaLevel'));
        Config.set('doCircus',            gb('s-doCircus'));
        Config.set('circusOpponentLevel', gs('s-circusLevel'));
        Config.set('doQuests',            gb('s-doQuests'));
        Config.set('questStrategy',       gs('s-questStrategy'));
        Config.set('doEventExpedition',   gb('s-doEvent'));
        Config.set('eventMonsterId',      gi('s-eventMonster'));
        Config.set('debugLevel',          gs('s-debugLevel'));

        // Quest types from checkboxes
        const qt = {};
        win.querySelectorAll('.s-qt-cb').forEach(cb => { qt[cb.dataset.type] = cb.checked; });
        Config.set('questTypes', qt);

        Config.bust(); // clear cache so next reads pick up new values
        Logger.info('Settings saved');
        this.close();
      });

      win.querySelector('#s-close').addEventListener('click', () => this.close());
    },

    _highlight(win) {
      // no-op; settings rendered with correct pre-selected values via HTML
    },
  };

  // ─────────────────────────────────────────────────────────────
  // BOOTSTRAP
  // ─────────────────────────────────────────────────────────────
  function boot() {
    UI.init();

    // Resume active session if it was running before page reload
    if (Config.get('active')) {
      Logger.info('Resuming active session');
      Engine.start();
    }
  }

  // Use DOMContentLoaded if document isn't ready, otherwise run immediately
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
