// ==UserScript==
// @name         Gladiatus Bot (v3)
// @version      3.1.0
// @description  Gladiatus automation — refactored for reliability, speed, and proper healing/quest logic
// @author       cansidee
// @match        *://*.gladiatus.gameforge.com/game/index.php*
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @require      https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js
// @resource     customCSS_global https://raw.githubusercontent.com/cansidee/gladiatus-script/master/global.css?ver=3.0
// ==/UserScript==

(function () {
  'use strict';

  console.log('[GBot] Script yuklendi! URL:', window.location.href);

  // mod=start sayfasinda calisma — @exclude glob'u ? karakterini yanlis yorumlar
  if (new URLSearchParams(window.location.search).get('mod') === 'start') return;

  // ─────────────────────────────────────────────────────────────
  // LOGGER
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
      else if (level === 'warn') console.warn(tag, ...args);
      else console.log(tag, ...args);
    },
    debug(...a) { this._print('debug', a); },
    info(...a) { this._print('info', a); },
    warn(...a) { this._print('warn', a); },
    error(...a) { this._print('error', a); },
  };

  // ─────────────────────────────────────────────────────────────
  // STORE
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
  // CONFIG
  // ─────────────────────────────────────────────────────────────
  const DEFAULTS = {
    active: false,
    language: 'EN',
    debugLevel: 'info',
    healThreshold: 30,
    resumeThreshold: 60,
    delayMin: 900,
    delayMax: 2400,
    doExpedition: true,
    monsterId: 0,
    doDungeon: true,
    dungeonDifficulty: 'normal',
    doArena: true,
    arenaOpponentLevel: 'min',
    doCircus: true,
    circusOpponentLevel: 'min',
    doQuests: true,
    questTypes: { combat: true, arena: true, circus: true, expedition: true, dungeon: true, items: true },
    questStrategy: 'reroll',
    doEventExpedition: true,
    eventMonsterId: 0,
  };

  const Config = {
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
    bust() { this._c = {}; },
  };

  // ─────────────────────────────────────────────────────────────
  // DOM
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
    attr(sel, attrName, root = document) {
      const el = this.qs(sel, root);
      return el ? el.getAttribute(attrName) : null;
    },
    remove(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    },
  };

  // ─────────────────────────────────────────────────────────────
  // PLAYER
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
  // PAGE
  // ─────────────────────────────────────────────────────────────
  const Page = {
    get bodyId() { return document.body ? document.body.id : ''; },
    get params() { return new URLSearchParams(window.location.search); },
    get mod() { return this.params.get('mod') || ''; },
    is(id) { return this.bodyId === id; },
    isQuests() { return this.is('questsPage'); },
    isLocation() { return this.is('locationPage'); },
    isDungeon() { return this.is('dungeonPage'); },
    isArena() { return this.is('arenaPage'); },
    isHealer() { return this.mod === 'healer'; },
    hasEventExpedition() {
      return DOM.exists('#submenu2 .menuitem.glow');
    },
    isOnEventExpedition() {
      return DOM.exists('#submenu2 .menuitem.active.glow');
    },
  };

  // ─────────────────────────────────────────────────────────────
  // COOLDOWN
  // ─────────────────────────────────────────────────────────────
  const Cooldown = {
    isReady(fillId) {
      const el = document.getElementById(fillId);
      return el ? el.classList.contains('cooldown_bar_fill_ready') : false;
    },
    remainingMs(textId) {
      const el = document.getElementById(textId);
      if (!el) return Infinity;
      return this._hmsToMs((el.innerText || el.textContent || '').trim());
    },
    tickerMs(sel) {
      const el = DOM.qs(sel);
      if (!el) return null;
      const v = el.getAttribute('data-ticker-time-left');
      return v !== null ? Number(v) : null;
    },
    _hmsToMs(t) {
      const parts = t.split(':');
      if (parts.length !== 3) return Infinity;
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      const s = Number(parts[2]);
      if ([h, m, s].some(isNaN)) return Infinity;
      return (h * 3600 + m * 60 + s) * 1000;
    },
  };

  // ─────────────────────────────────────────────────────────────
  // TIMER
  // ─────────────────────────────────────────────────────────────
  const Timer = {
    _tid: null,
    _iid: null,
    schedule(fn, ms) {
      this.cancelTimer();
      this._tid = setTimeout(fn, ms);
    },
    loop(fn, ms) {
      this.cancelLoop();
      this._iid = setInterval(fn, ms);
    },
    cancelTimer() {
      if (this._tid !== null) { clearTimeout(this._tid); this._tid = null; }
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
  // Utility
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
  // ENGINE
  // ─────────────────────────────────────────────────────────────
  const Engine = {
    _running: false,
    _healingMode: false,
    _healRetries: 0,
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

    schedule(ms) {
      if (!this._running) return;
      Timer.cancelTimer();
      Timer.schedule(() => this.tick(), ms);
    },

    tick() {
      if (!this._running) return;
      try {
        this._doTick();
      } catch (e) {
        Logger.error('tick() hatasi — 5sn sonra tekrar denenecek:', e);
        this.schedule(5000);
      }
    },

    _doTick() {
      const delay = randDelay();

      if (this._tryDismissDialogs(delay)) return;

      const hp = Player.hp;
      const healThr = Config.get('healThreshold');
      const resumeThr = Config.get('resumeThreshold');

      if (this._healingMode) {
        if (hp >= resumeThr) {
          Logger.info(`HP ${hp}% — iyelesti. Devam ediliyor.`);
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
        Logger.warn(`HP ${hp}% esik altinda (${healThr}%). Iyelestirme moduna geciliyor.`);
        this._healingMode = true;
        this._healRetries = 0;
        UI.showHealingAlert(hp);
        this._doHealCycle(delay);
        return;
      }

      if (Config.get('doQuests') && Store.get('nextQuestTime', 0) < Date.now()) {
        Logger.info('Tick -> quests');
        Timer.schedule(() => Actions.quests(() => this.schedule(delay)), delay);
        return;
      }

      if (Config.get('doExpedition') && Cooldown.isReady('cooldown_bar_fill_expedition')) {
        Logger.info('Tick -> expedition');
        Timer.schedule(() => Actions.expedition(() => this.schedule(delay)), delay);
        return;
      }

      if (Config.get('doDungeon') && Player.level >= 10 && Cooldown.isReady('cooldown_bar_fill_dungeon')) {
        Logger.info('Tick -> dungeon');
        Timer.schedule(() => Actions.dungeon(() => this.schedule(delay)), delay);
        return;
      }

      if (Config.get('doArena') && Player.level >= 2 && Cooldown.isReady('cooldown_bar_fill_arena')) {
        Logger.info('Tick -> arena');
        Timer.schedule(() => Actions.arena(() => this.schedule(delay + 600)), delay + 600);
        return;
      }

      if (Config.get('doCircus') && Player.level >= 10 && Cooldown.isReady('cooldown_bar_fill_ct')) {
        Logger.info('Tick -> circus');
        Timer.schedule(() => Actions.circus(() => this.schedule(delay + 600)), delay + 600);
        return;
      }

      const evPts = this._eventPoints();
      const evNext = Store.get('nextEventExpeditionTime', 0);
      if (Config.get('doEventExpedition') && Page.hasEventExpedition() && evPts > 0 && evNext < Date.now()) {
        Logger.info('Tick -> event expedition');
        Timer.schedule(() => Actions.eventExpedition(() => this.schedule(delay)), delay);
        return;
      }

      this._waitForNext();
    },

    _doHealCycle(delay) {
      if (this._healRetries >= this.MAX_HEAL_RETRIES) {
        Logger.warn('Max heal retry asildi. 2dk bekleniyor.');
        this._healRetries = 0;
        UI.showHealingAlert(Player.hp, true);
        this.schedule(120000);
        return;
      }
      this._healRetries++;
      UI.showHealingAlert(Player.hp);
      Timer.schedule(() => Actions.healer(() => this.schedule(5000)), delay);
    },

    _tryDismissDialogs(delay) {
      const loginBonus = document.getElementById('blackoutDialogLoginBonus');
      if (loginBonus) {
        const btn = loginBonus.querySelector('input[type=submit], input[type=button], button');
        if (btn) {
          Logger.info('Login bonus kapatiliyor');
          Timer.schedule(() => { btn.click(); this.schedule(delay); }, delay);
          return true;
        }
      }

      const notif = document.getElementById('blackoutDialognotification');
      if (notif) {
        const style = window.getComputedStyle(notif);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const btn = notif.querySelector('input[type=submit], input[type=button], button');
          if (btn) {
            Logger.info('Bildirim kapatiliyor');
            Timer.schedule(() => { btn.click(); this.schedule(delay); }, delay);
            return true;
          }
        }
      }

      return false;
    },

    _waitForNext() {
      Timer.cancelAll();
      UI.removeOverlays();

      const candidates = this._buildCandidateList();

      if (!candidates.length) {
        Logger.info('Aktif eylem yok — 5dk bekleniyor');
        UI.showNextAction('—', 300000);
        this.schedule(300000);
        return;
      }

      candidates.sort((a, b) => a.ms - b.ms);
      const next = candidates[0];
      Logger.info(`[${next.name}] icin bekleniyor: ${formatTime(next.ms)}`);

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
  // ACTIONS
  // ─────────────────────────────────────────────────────────────
  const Actions = {

    healer(done) {
      if (!Page.isHealer()) {
        const link =
          DOM.qs('a[href*="mod=healer"]') ||
          DOM.qs('#submenu a[href*="healer"]') ||
          DOM.qs('.city-healer-link');

        if (link) {
          Logger.info('Healer linkine gidiliyor');
          link.click();
        } else {
          Logger.info('Healer URL ile navigasyon');
          const base = window.location.href.split('?')[0];
          window.location.href = base + '?mod=healer';
        }
        return;
      }

      const healBtn =
        DOM.qs('#heal_button') ||
        DOM.qs('input[name*="heal"]') ||
        DOM.qs('input[value*="eal"]') ||
        DOM.qs('a[href*="heal_all"]') ||
        DOM.qs('.heal-button') ||
        DOM.qs('form[action*="healer"] .button1') ||
        DOM.qs('form[action*="healer"] input[type=submit]');

      if (healBtn) {
        Logger.info('Heal butonu tiklanıyor');
        healBtn.click();
      } else {
        const errEl = DOM.qs('.error-message, [class*="not-enough"], .healer-no-gold');
        if (errEl) {
          Logger.warn('Altin yetersiz:', errEl.textContent.trim());
        } else {
          Logger.warn('Heal butonu bulunamadi — DOM yapisi degismis olabilir');
        }
      }

      done();
    },

    quests(done) {
      if (!Page.isQuests()) {
        const link =
          DOM.qs('#mainmenu a[href*="mod=quests"]') ||
          DOM.qs('a[href*="mod=quests"]');

        if (link) {
          Logger.info('Quest sayfasina gidiliyor');
          link.click();
        } else {
          const links = DOM.qsa('#mainmenu a.menuitem');
          if (links[1]) {
            Logger.info('Quest sayfasina (fallback index) gidiliyor');
            links[1].click();
          } else {
            Logger.warn('Quest menu linki bulunamadi — 1dk atlaniyor');
            Store.set('nextQuestTime', Date.now() + 60000);
            done();
          }
        }
        return;
      }

      const finishBtn = DOM.qs('#content .contentboard_slot a.quest_slot_button_finish');
      if (finishBtn) {
        Logger.info('Quest tamamlaniyor');
        finishBtn.click();
        return;
      }

      const restartBtn = DOM.qs('#content .contentboard_slot a.quest_slot_button_restart');
      if (restartBtn) {
        Logger.info('Quest yeniden baslatiliyor');
        restartBtn.click();
        return;
      }

      const acceptSlots = DOM.qsa('#content .contentboard_slot a.quest_slot_button_accept');
      if (acceptSlots.length) {
        this._acceptQuest(done);
        return;
      }

      this._recordQuestCooldown(done);
    },

    _acceptQuest(done) {
      const questTypes = Config.get('questTypes');

      const slots = DOM.qsa('#content .contentboard_slot_inactive');
      for (const slot of slots) {
        const iconEl = slot.querySelector('.quest_slot_icon');
        if (!iconEl) continue;

        const bg = iconEl.style.backgroundImage || '';
        const m = bg.match(/icon_([a-z]+?)(?:_inactive)?["')]/i);
        if (!m) continue;

        let icon = m[1].toLowerCase();
        if (icon === 'grouparena') icon = 'circus';

        if (questTypes[icon]) {
          const btn = slot.querySelector('.quest_slot_button_accept');
          if (btn) {
            Logger.info(`Quest kabul ediliyor: ${icon}`);
            btn.click();
            return;
          }
        }
      }

      const strategy = Config.get('questStrategy');
      Logger.info(`Tercih edilen quest yok. Strateji: ${strategy}`);

      if (strategy === 'reroll') {
        const rerollBtn = DOM.qs('#quest_footer_reroll input');
        if (rerollBtn) {
          Logger.info('Reroll yapiliyor');
          rerollBtn.click();
          return;
        }
        Logger.warn('Reroll butonu yok — wait stratejisine geciliyor');
      }

      if (strategy === 'best') {
        const firstSlot = DOM.qs('#content .contentboard_slot_inactive .quest_slot_button_accept');
        if (firstSlot) {
          Logger.info('En iyi mevcut quest kabul ediliyor');
          firstSlot.click();
          return;
        }
      }

      this._recordQuestCooldown(done);
    },

    _recordQuestCooldown(done) {
      const tickerMs = Cooldown.tickerMs('#quest_header_cooldown b span[data-ticker-time-left]');

      let next;
      if (tickerMs !== null && tickerMs > 0) {
        next = Date.now() + tickerMs;
        Logger.info(`Quest cooldown: ${formatTime(tickerMs)}`);
      } else {
        next = Date.now() + 300000;
        Logger.info('Quest cooldown bilinmiyor — 5dk bekleniyor');
      }

      Store.set('nextQuestTime', next);
      done();
    },

    expedition(done) {
      if (!Page.isLocation()) {
        const link = this._findCooldownLink('expedition') || DOM.qsa('.cooldown_bar_link')[0];
        if (link) {
          Logger.info('Expedition sayfasina gidiliyor');
          link.click();
        } else {
          Logger.warn('Expedition linki bulunamadi');
          done();
        }
        return;
      }

      if (Page.isOnEventExpedition()) {
        Logger.info('Event expedition sayfasinda — geri gidiliyor');
        window.history.back();
        return;
      }

      const id = Number(Config.get('monsterId'));
      const buttons = DOM.qsa('.expedition_button');

      if (buttons[id]) {
        Logger.info(`Expedition: slot ${id} saldiriliyor`);
        buttons[id].click();
      } else if (buttons.length) {
        Logger.warn(`Slot ${id} yok — slot 0 kullaniliyor`);
        buttons[0].click();
      } else {
        Logger.warn('Expedition butonu bulunamadi');
        done();
      }
    },

    dungeon(done) {
      if (!Page.isDungeon()) {
        const link = this._findCooldownLink('dungeon') || DOM.qsa('.cooldown_bar_link')[1];
        if (link) {
          Logger.info('Dungeon sayfasina gidiliyor');
          link.click();
        } else {
          Logger.warn('Dungeon linki bulunamadi');
          done();
        }
        return;
      }

      const mapArea = DOM.qs('#content area');

      if (!mapArea) {
        const diff = Config.get('dungeonDifficulty');
        const buttons = DOM.qsa('#content .button1');
        const idx = diff === 'advanced' ? 1 : 0;
        const btn = buttons[idx] || buttons[0];

        if (btn) {
          Logger.info(`Dungeon zorlugu seciliyor: ${diff}`);
          btn.click();
        } else {
          Logger.warn('Dungeon zorluk butonu bulunamadi');
          done();
        }
      } else {
        Logger.info('Dungeona giriliyor');
        mapArea.click();
      }
    },

    arena(done) {
      if (!Page.isArena()) {
        const link = this._findCooldownLink('arena')
          || DOM.qsa('.cooldown_bar_link')[Player.level < 10 ? 1 : 2];
        if (link) {
          Logger.info('Arena sayfasina gidiliyor');
          link.click();
        } else {
          Logger.warn('Arena linki bulunamadi');
          done();
        }
        return;
      }

      const provTabContent = document.getElementById('own2');
      if (!provTabContent || getComputedStyle(provTabContent).display === 'none') {
        const tab = DOM.qs('td:nth-child(2) > .awesome-tabs');
        if (tab && !tab.classList.contains('current')) {
          Logger.info('Provinciarum sekmesi aciliyor');
          tab.click();
          return;
        }
      }

      const levels = this._extractLevels('#own2');
      const attackBtns = DOM.qsa('#own2 .attack, #own2 a[href*="fight"]');

      if (!levels.length || !attackBtns.length) {
        Logger.warn('Arena: rakip bulunamadi');
        done();
        return;
      }

      const idx = this._pickIndex(levels, Config.get('arenaOpponentLevel'));
      if (attackBtns[idx]) {
        Logger.info(`Arena: ${idx}. rakip saldiriliyor (lvl ${levels[idx]})`);
        attackBtns[idx].click();
      } else {
        Logger.warn(`Arena: index ${idx} saldiri butonu yok`);
        done();
      }
    },

    circus(done) {
      if (!Page.isArena()) {
        const link = this._findCooldownLink('ct')
          || this._findCooldownLink('circus')
          || DOM.qsa('.cooldown_bar_link')[3];
        if (link) {
          Logger.info('Circus sayfasina gidiliyor');
          link.click();
        } else {
          Logger.warn('Circus linki bulunamadi');
          done();
        }
        return;
      }

      const circusContent = document.getElementById('own3');
      if (!circusContent || getComputedStyle(circusContent).display === 'none') {
        const tab = DOM.qs('td:nth-child(4) > .awesome-tabs');
        if (tab && !tab.classList.contains('current')) {
          Logger.info('Circus Turma sekmesi aciliyor');
          tab.click();
          return;
        }
      }

      const levels = this._extractLevels('#own3');
      const attackBtns = DOM.qsa('#own3 .attack, #own3 a[href*="fight"]');

      if (!levels.length || !attackBtns.length) {
        Logger.warn('Circus: rakip bulunamadi');
        done();
        return;
      }

      const idx = this._pickIndex(levels, Config.get('circusOpponentLevel'));
      if (attackBtns[idx]) {
        Logger.info(`Circus: ${idx}. rakip saldiriliyor (lvl ${levels[idx]})`);
        attackBtns[idx].click();
      } else {
        Logger.warn(`Circus: index ${idx} saldiri butonu yok`);
        done();
      }
    },

    eventExpedition(done) {
      const today = serverDateString();
      const saved = Store.get('eventPoints', null);
      let pts = (saved && saved.date === today) ? Number(saved.count) : 16;

      if (!Page.isOnEventExpedition()) {
        const link = DOM.qs('#submenu2 .menuitem.glow');
        if (link) {
          Logger.info('Event expedition sayfasina gidiliyor');
          link.click();
        } else {
          Logger.warn('Event expedition linki bulunamadi');
          done();
        }
        return;
      }

      const ptEl = DOM.qs('#content .section-header p:nth-child(2)');
      if (ptEl) {
        const raw = (ptEl.firstChild?.nodeValue || ptEl.textContent || '').replace(/[^0-9]/g, '');
        if (raw) pts = Number(raw);
        Store.set('eventPoints', { count: pts, date: today });
      }

      const timerEl = DOM.qs('#content .ticker[data-ticker-time-left]');
      if (timerEl) {
        const ms = Number(timerEl.getAttribute('data-ticker-time-left')) || 0;
        Logger.info(`Event expedition cooldown: ${formatTime(ms)}`);
        Store.set('nextEventExpeditionTime', Date.now() + ms);
        location.reload();
        return;
      }

      if (pts <= 0) {
        Logger.info('Bugunluk event puan bitti');
        location.reload();
        return;
      }

      const mId = Number(Config.get('eventMonsterId'));
      const buttons = DOM.qsa('.expedition_button');
      const isBoss = mId === 3;
      const effectiveId = (isBoss && pts < 2) ? 2 : mId;
      const btn = buttons[effectiveId] || buttons[0];

      if (!btn) {
        Logger.warn('Event expedition: buton bulunamadi');
        done();
        return;
      }

      Logger.info(`Event expedition: slot ${effectiveId} (kalan ${pts} puan)`);
      Store.set('eventPoints', { count: pts - (effectiveId === 3 ? 2 : 1), date: today });
      Store.set('nextEventExpeditionTime', Date.now() + 303000);
      btn.click();
    },

    _findCooldownLink(keyword) {
      return DOM.qsa('.cooldown_bar_link').find(l => (l.href || '').toLowerCase().includes(keyword)) || null;
    },

    _extractLevels(tableSelector) {
      const tds = DOM.qsa(`${tableSelector} td`);
      const levels = [];
      for (let i = 1; i < tds.length && levels.length < 5; i += 4) {
        const raw = (tds[i]?.firstChild?.nodeValue || tds[i]?.textContent || '').trim();
        const v = Number(raw);
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
  // UI
  // ─────────────────────────────────────────────────────────────
  const UI = {
    _btnInjected: false,

    init() {
      try { GM_addStyle(GM_getResourceText('customCSS_global')); } catch {}
      this._tryInjectButtons();
    },

    _tryInjectButtons() {
      if (this._btnInjected) return;
      if (document.body) {
        this._injectFloatingBar();
        this._btnInjected = true;
      } else {
        setTimeout(() => this._tryInjectButtons(), 300);
      }
    },

    _injectFloatingBar() {
      if (document.getElementById('gbotBar')) return;

      const bar = document.createElement('div');
      bar.id = 'gbotBar';
      bar.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;display:flex;gap:4px;padding:4px 8px;background:rgba(0,0,0,0.75);border-bottom-left-radius:8px;';

      const startBtn = document.createElement('button');
      startBtn.id = 'autoGoButton';
      startBtn.style.cssText = 'cursor:pointer;font-weight:bold;padding:4px 12px;background:#1a1a1a;color:#58ffbb;border:1px solid #58ffbb;border-radius:4px;font-size:13px;';
      startBtn.textContent = Engine.running ? 'DUR' : 'AUTO GO';
      startBtn.addEventListener('click', () => {
        if (Engine.running) Engine.stop(); else Engine.start();
      });

      const settingsBtn = document.createElement('button');
      settingsBtn.id = 'settingsOpenBtn';
      settingsBtn.style.cssText = 'cursor:pointer;padding:4px 8px;background:#1a1a1a;color:#ccc;border:1px solid #444;border-radius:4px;font-size:13px;';
      settingsBtn.textContent = '⚙';
      settingsBtn.title = 'Bot Ayarlari';
      settingsBtn.addEventListener('click', () => Settings.open());

      bar.appendChild(startBtn);
      bar.appendChild(settingsBtn);
      document.body.appendChild(bar);
    },

    syncButton() {
      const btn = document.getElementById('autoGoButton');
      if (btn) btn.textContent = Engine.running ? 'DUR' : 'AUTO GO';
    },

    showNextAction(name, ms) {
      this.removeHealingAlert();
      let el = document.getElementById('nextActionWindow');
      if (!el) {
        el = document.createElement('div');
        el.id = 'nextActionWindow';
        el.style.cssText = 'position:absolute;top:120px;left:506px;width:365px;padding:13px 0;color:#58ffbb;background:#000000db;font-size:20px;text-align:center;border-radius:20px;border-left:10px solid #58ffbb;border-right:10px solid #58ffbb;z-index:999;';
        const hg = document.getElementById('header_game');
        if (hg) hg.insertBefore(el, hg.firstElementChild);
      }
      el.innerHTML = `<span style="color:#fff">Sonraki: </span><b>${name}</b><br><span style="color:#fff">Kalan: </span><span id="nadCountdown">${formatTime(ms)}</span>`;
    },

    updateCountdown(ms) {
      const el = document.getElementById('nadCountdown');
      if (el) el.textContent = formatTime(ms);
    },

    showHealingAlert(hp, waiting = false) {
      DOM.remove('nextActionWindow');
      let el = document.getElementById('healingAlert');
      if (!el) {
        el = document.createElement('div');
        el.id = 'healingAlert';
        el.style.cssText = 'position:absolute;top:120px;left:506px;width:365px;padding:20px 0;color:#ea1414;background:#000000db;font-size:20px;text-align:center;border-radius:25px;border-left:10px solid #ea1414;border-right:10px solid #ea1414;z-index:999;';
        const hg = document.getElementById('header_game');
        if (hg) hg.insertBefore(el, hg.firstElementChild);
      }
      el.innerHTML = waiting
        ? `<b>Dusuk HP (${hp}%)</b><br><span style="font-size:14px">Iyelestirme icin altin bekleniyor...</span>`
        : `<b>Dusuk HP (${hp}%)</b><br><span style="font-size:14px">Healera gidiliyor...</span>`;
    },

    removeHealingAlert() { DOM.remove('healingAlert'); },
    removeOverlays() { DOM.remove('nextActionWindow'); DOM.remove('healingAlert'); },
  };

  // ─────────────────────────────────────────────────────────────
  // SETTINGS PANEL
  // ─────────────────────────────────────────────────────────────
  const Settings = {
    open() {
      if (document.getElementById('settingsWindow')) return;

      const overlay = document.createElement('div');
      overlay.id = 'overlayBack';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;';
      overlay.addEventListener('click', () => this.close());
      document.body.appendChild(overlay);

      const win = document.createElement('div');
      win.id = 'settingsWindow';
      win.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#111;color:#ccc;padding:20px;border-radius:12px;z-index:1001;min-width:480px;max-height:80vh;overflow-y:auto;font-family:sans-serif;font-size:13px;';
      win.innerHTML = this._html();
      document.body.appendChild(win);

      this._wire(win);
    },

    close() {
      DOM.remove('settingsWindow');
      DOM.remove('overlayBack');
    },

    _html() {
      const c = (key, val) => Config.get(key) === val ? 'selected' : '';
      const chk = key => Config.get(key) ? 'checked' : '';
      return `
        <h2 style="margin:0 0 12px;color:#58ffbb;font-size:16px;">⚙ Bot Ayarlari</h2>

        <div class="s-section">
          <b>HP Esikleri</b>
          <label>Iyelestir (altinda): <input id="s-healThr" type="number" min="1" max="99" value="${Config.get('healThreshold')}">%</label>
          <label>Devam et (ustunde): <input id="s-resumeThr" type="number" min="1" max="99" value="${Config.get('resumeThreshold')}">%</label>
        </div>

        <div class="s-section">
          <b>Gecikme</b>
          <label>Min: <input id="s-delayMin" type="number" min="300" max="5000" value="${Config.get('delayMin')}"> ms</label>
          <label>Max: <input id="s-delayMax" type="number" min="300" max="5000" value="${Config.get('delayMax')}"> ms</label>
        </div>

        <div class="s-section">
          <b>Expedition</b>
          <label><input type="checkbox" id="s-doExp" ${chk('doExpedition')}> Aktif</label>
          <label>Canavar slotu:
            <select id="s-monsterId">
              <option value="0" ${Config.get('monsterId') == 0 ? 'selected' : ''}>1</option>
              <option value="1" ${Config.get('monsterId') == 1 ? 'selected' : ''}>2</option>
              <option value="2" ${Config.get('monsterId') == 2 ? 'selected' : ''}>3</option>
              <option value="3" ${Config.get('monsterId') == 3 ? 'selected' : ''}>Boss</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Dungeon</b>
          <label><input type="checkbox" id="s-doDun" ${chk('doDungeon')}> Aktif</label>
          <label>Zorluk:
            <select id="s-dungeonDiff">
              <option value="normal" ${c('dungeonDifficulty', 'normal')}>Normal</option>
              <option value="advanced" ${c('dungeonDifficulty', 'advanced')}>Gelismis</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Arena</b>
          <label><input type="checkbox" id="s-doArena" ${chk('doArena')}> Aktif</label>
          <label>Rakip:
            <select id="s-arenaLevel">
              <option value="min" ${c('arenaOpponentLevel', 'min')}>En dusuk</option>
              <option value="max" ${c('arenaOpponentLevel', 'max')}>En yuksek</option>
              <option value="random" ${c('arenaOpponentLevel', 'random')}>Rastgele</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Circus Turma</b>
          <label><input type="checkbox" id="s-doCircus" ${chk('doCircus')}> Aktif</label>
          <label>Rakip:
            <select id="s-circusLevel">
              <option value="min" ${c('circusOpponentLevel', 'min')}>En dusuk</option>
              <option value="max" ${c('circusOpponentLevel', 'max')}>En yuksek</option>
              <option value="random" ${c('circusOpponentLevel', 'random')}>Rastgele</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Questler</b>
          <label><input type="checkbox" id="s-doQuests" ${chk('doQuests')}> Aktif</label>
          <label>Strateji:
            <select id="s-questStrategy">
              <option value="reroll" ${c('questStrategy', 'reroll')}>Reroll</option>
              <option value="best" ${c('questStrategy', 'best')}>En iyiyi kabul et</option>
              <option value="wait" ${c('questStrategy', 'wait')}>Bekle</option>
            </select>
          </label>
          <div style="margin-top:6px"><b>Quest turleri:</b></div>
          ${this._questTypeCheckboxes()}
        </div>

        <div class="s-section">
          <b>Event Expedition</b>
          <label><input type="checkbox" id="s-doEvent" ${chk('doEventExpedition')}> Aktif</label>
          <label>Canavar slotu:
            <select id="s-eventMonster">
              <option value="0" ${Config.get('eventMonsterId') == 0 ? 'selected' : ''}>1</option>
              <option value="1" ${Config.get('eventMonsterId') == 1 ? 'selected' : ''}>2</option>
              <option value="2" ${Config.get('eventMonsterId') == 2 ? 'selected' : ''}>3</option>
              <option value="3" ${Config.get('eventMonsterId') == 3 ? 'selected' : ''}>Boss</option>
            </select>
          </label>
        </div>

        <div class="s-section">
          <b>Debug</b>
          <label>Log seviyesi:
            <select id="s-debugLevel">
              <option value="debug" ${c('debugLevel', 'debug')}>Debug</option>
              <option value="info" ${c('debugLevel', 'info')}>Info</option>
              <option value="warn" ${c('debugLevel', 'warn')}>Warn</option>
              <option value="error" ${c('debugLevel', 'error')}>Error</option>
            </select>
          </label>
        </div>

        <div style="text-align:right;margin-top:14px">
          <button id="s-save" style="margin-right:8px;padding:6px 14px;cursor:pointer;">Kaydet</button>
          <button id="s-close" style="padding:6px 14px;cursor:pointer;">Iptal</button>
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
      const types = Config.get('questTypes');
      const labels = { combat: 'Dovus', arena: 'Arena', circus: 'Circus', expedition: 'Expedition', dungeon: 'Dungeon', items: 'Esya' };
      return '<div class="s-qt">' +
        Object.entries(labels).map(([k, v]) =>
          `<label><input type="checkbox" class="s-qt-cb" data-type="${k}" ${types[k] ? 'checked' : ''}><span> ${v}</span></label>`
        ).join('') +
        '</div>';
    },

    _wire(win) {
      win.querySelector('#s-save').addEventListener('click', () => {
        const g = id => win.querySelector('#' + id);
        const gi = id => Number(g(id).value);
        const gb = id => g(id).checked;
        const gs = id => g(id).value;

        Config.set('healThreshold', gi('s-healThr'));
        Config.set('resumeThreshold', gi('s-resumeThr'));
        Config.set('delayMin', gi('s-delayMin'));
        Config.set('delayMax', gi('s-delayMax'));
        Config.set('doExpedition', gb('s-doExp'));
        Config.set('monsterId', gi('s-monsterId'));
        Config.set('doDungeon', gb('s-doDun'));
        Config.set('dungeonDifficulty', gs('s-dungeonDiff'));
        Config.set('doArena', gb('s-doArena'));
        Config.set('arenaOpponentLevel', gs('s-arenaLevel'));
        Config.set('doCircus', gb('s-doCircus'));
        Config.set('circusOpponentLevel', gs('s-circusLevel'));
        Config.set('doQuests', gb('s-doQuests'));
        Config.set('questStrategy', gs('s-questStrategy'));
        Config.set('doEventExpedition', gb('s-doEvent'));
        Config.set('eventMonsterId', gi('s-eventMonster'));
        Config.set('debugLevel', gs('s-debugLevel'));

        const qt = {};
        win.querySelectorAll('.s-qt-cb').forEach(cb => { qt[cb.dataset.type] = cb.checked; });
        Config.set('questTypes', qt);

        Config.bust();
        Logger.info('Ayarlar kaydedildi');
        this.close();
      });

      win.querySelector('#s-close').addEventListener('click', () => this.close());
    },
  };

  // ─────────────────────────────────────────────────────────────
  // BOOTSTRAP
  // ─────────────────────────────────────────────────────────────
  function boot() {
    UI.init();

    if (Config.get('active')) {
      Logger.info('Onceki oturum devam ettiriliyor');
      Engine.start();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
