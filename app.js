/* 酒典 Liquor Atlas — app */
(() => {
  'use strict';

  // ---------------------------------------------------------------- utils
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => { try { const x = new URL(String(u), location.href); return /^https?:$/.test(x.protocol) ? x.href : '#'; } catch (e) { return '#'; } };
  const fmt = n => Math.round(Number(n)).toLocaleString('en-US');
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const SYM = { USD: 'US$', GBP: '£', EUR: '€', JPY: '¥', CNY: 'CN¥', HKD: 'HK$', AUD: 'A$', CAD: 'C$', TWD: 'NT$', KRW: '₩', SGD: 'S$', CHF: 'CHF ', MXN: 'MX$', NZD: 'NZ$' };
  const b64enc = s => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
  const b64dec = s => { const bin = atob(String(s).replace(/\s/g, '')); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new TextDecoder().decode(b); };
  const GLYPH = '<svg viewBox="0 0 22 34" fill="currentColor" aria-hidden="true"><path d="M8.5 0h5v2.2h-.7v6.1c0 1.5.6 2.3 2 3.6 1.6 1.5 2.7 3 2.7 5.6V31a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3V17.5c0-2.6 1.100-4.100 2.700-5.600 1.400-1.300 2-2.100 2-3.600V2.200h-.700z"/></svg>';
  const STATUS = { wish: '想買', owned: '庫存中', finished: '已喝完' };
  const MARK = { wish: '♡', owned: '◆', finished: '✓' };

  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
  }

  // ---------------------------------------------------------------- state
  const S = { meta: null, data: {}, mix: {}, cat: null, rendered: '', drawerPushed: false, f: null, lastFocus: null };
  const newFilter = () => ({ q: '', sort: 'rank', types: new Set(), country: '', band: -1, flags: new Set(), shown: 40, open: false });
  const LS = { log: 'la.log.v1', sync: 'la.sync.v1', age: 'la.age.v1' };

  // ---------------------------------------------------------------- log store
  const Store = {
    entries: {},
    load() { try { this.entries = (JSON.parse(localStorage.getItem(LS.log) || '{}').entries) || {}; } catch (e) { this.entries = {}; } },
    save() { try { localStorage.setItem(LS.log, JSON.stringify({ v: 1, entries: this.entries })); } catch (e) { toast('無法寫入瀏覽器儲存空間'); } },
    live() { return Object.values(this.entries).filter(e => e && !e.deleted); },
    byBottle(bid) { return this.live().filter(e => e.bid === bid).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); },
    status(bid) {
      const es = this.byBottle(bid);
      for (const s of ['owned', 'finished', 'wish']) if (es.some(e => e.status === s)) return s;
      return '';
    },
    statusMap() {
      const m = {}, rank = { wish: 1, finished: 2, owned: 3 };
      for (const e of this.live()) if (!m[e.bid] || rank[e.status] > rank[m[e.bid]]) m[e.bid] = e.status;
      return m;
    },
    upsert(e) { e.updatedAt = Date.now(); if (!e.createdAt) e.createdAt = e.updatedAt; this.entries[e.eid] = e; this.save(); Sync.schedule(); updateCount(); },
    remove(eid) { const e = this.entries[eid]; if (e) { e.deleted = true; e.updatedAt = Date.now(); this.save(); Sync.schedule(); updateCount(); } },
    merge(remote) {
      const r = (remote && remote.entries) || {};
      let changedLocal = false, needPush = false;
      for (const [k, v] of Object.entries(r)) {
        const l = this.entries[k];
        if (v && (!l || (v.updatedAt || 0) > (l.updatedAt || 0))) { this.entries[k] = v; changedLocal = true; }
      }
      for (const [k, v] of Object.entries(this.entries)) {
        const x = r[k];
        if (!x || (v.updatedAt || 0) > (x.updatedAt || 0)) needPush = true;
      }
      if (changedLocal) this.save();
      return { changedLocal, needPush };
    }
  };

  // ---------------------------------------------------------------- GitHub sync
  const Sync = {
    cfg: { repo: '', token: '', path: 'log.json' },
    state: 'off', msg: '尚未設定同步，紀錄只存在這台裝置的瀏覽器。', timer: null, busy: false, again: false,
    load() {
      try { Object.assign(this.cfg, JSON.parse(localStorage.getItem(LS.sync) || '{}')); } catch (e) { /* ignore */ }
      if (!this.cfg.repo) this.cfg.repo = (S.meta && S.meta.repo) || '';
      if (this.enabled()) this.set('off', '已設定同步。');
    },
    saveCfg() { localStorage.setItem(LS.sync, JSON.stringify(this.cfg)); },
    enabled() { return !!(this.cfg.repo && this.cfg.token); },
    set(state, msg) {
      this.state = state; this.msg = msg || '';
      const d = $('#sync-dot'); if (d) { d.dataset.s = state; d.title = this.msg; }
      const m = $('#sync-msg'); if (m) m.textContent = this.msg;
    },
    schedule() { if (!this.enabled()) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 1200); },
    api(method, body) {
      return fetch(`https://api.github.com/repos/${this.cfg.repo}/contents/${this.cfg.path}`, {
        method, cache: 'no-store',
        headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body ? JSON.stringify(body) : undefined
      });
    },
    async run() {
      if (!this.enabled()) return false;
      if (this.busy) { this.again = true; return false; }
      this.busy = true; this.set('busy', '同步中…');
      let ok = false;
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await this.api('GET');
          let sha = null, remote = { entries: {} };
          if (r.status === 200) {
            const j = await r.json(); sha = j.sha;
            try { remote = JSON.parse(b64dec(j.content || '') || '{}'); } catch (e) { remote = { entries: {} }; }
          } else if (r.status === 401) { throw new Error('Token 無效或已過期'); }
          else if (r.status !== 404) { throw new Error('讀取失敗（HTTP ' + r.status + '）'); }
          const { changedLocal, needPush } = Store.merge(remote);
          if (changedLocal) { updateCount(); refreshAfterSync(); }
          if (!needPush) { ok = true; break; }
          const p = await this.api('PUT', Object.assign({
            message: 'log: update ' + new Date().toISOString(),
            content: b64enc(JSON.stringify({ v: 1, entries: Store.entries }, null, 1))
          }, sha ? { sha } : {}));
          if (p.ok) { ok = true; break; }
          if (p.status === 409 || p.status === 422) continue;
          if (p.status === 404 || p.status === 403) throw new Error('找不到 repo，或 Token 沒有該 repo 的 Contents 讀寫權限');
          if (p.status === 401) throw new Error('Token 無效或已過期');
          throw new Error('寫入失敗（HTTP ' + p.status + '）');
        }
        if (!ok) throw new Error('多裝置同時寫入，請稍後再試');
        this.set('ok', '已同步 ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }));
      } catch (e) {
        this.set('err', '同步失敗：' + (e && e.message ? e.message : e));
      } finally {
        this.busy = false;
        if (this.again) { this.again = false; this.schedule(); }
      }
      return ok;
    }
  };

  function refreshAfterSync() {
    const p = parseHash();
    if (p[0] === 'cellar') renderCellar();
    else if (S.cat && S.rendered === S.cat.id + ':list') { paintList(); if (p[1] === 'b' && p[2]) paintLog(p[2]); }
  }
  function updateCount() {
    const n = Store.live().length; const c = $('#cellar-count');
    if (c) { c.textContent = n; c.hidden = !n; }
  }

  // ---------------------------------------------------------------- data
  async function getJSON(path) {
    const r = await fetch(path + '?v=' + encodeURIComponent((S.meta && S.meta.build) || Date.now()));
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }
  async function loadCat(id) {
    if (!S.data[id]) {
      const d = await getJSON('data/' + id + '.json');
      for (const b of d.items) {
        b._s = [b.name, b.zh, b.local, b.producer, b.country, b.region, b.type, (b.tags || []).join(' ')].join(' ').toLowerCase();
        b._tw = b.tw && b.tw.offers && b.tw.offers.length ? b.tw.offers[0].price : null;
        b._intl = intlTwd(b.intl);
        b._ref = b._tw != null ? b._tw : b._intl;
      }
      S.data[id] = d;
    }
    return S.data[id];
  }
  function intlTwd(pi) {
    if (!pi || typeof pi.amt !== 'number') return null;
    const rate = pi.cur === 'TWD' ? 1 : S.meta.fx[pi.cur];
    return rate ? pi.amt * rate : null;
  }
  const pfName = id => { const p = (S.meta.platforms || []).find(x => x.id === id); return p ? p.name : id; };
  const bands = cat => cat.bands || [1000, 2000, 4000, 8000];
  function bandLabel(cat, i) {
    const b = bands(cat);
    if (i === 0) return 'NT$' + fmt(b[0]) + ' 以下';
    if (i === b.length) return 'NT$' + fmt(b[b.length - 1]) + ' 以上';
    return 'NT$' + fmt(b[i - 1]) + '–' + fmt(b[i]);
  }
  function inBand(cat, i, price) {
    if (price == null) return false;
    const b = bands(cat);
    return (i === 0 || price >= b[i - 1]) && (i === b.length || price < b[i]);
  }

  // ---------------------------------------------------------------- routing
  function parseHash() { return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } }); }
  function setCat(cat) {
    S.cat = cat;
    document.documentElement.style.setProperty('--cat-h', cat ? cat.hue : 28);
    $$('.cat-tab').forEach(a => { if (cat && a.dataset.id === cat.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const act = $('.cat-tab[aria-current="page"]');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'center' });
    $$('.mast-btn[data-route]').forEach(a => { if (!cat && parseHash()[0] === a.dataset.route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  async function route() {
    if (location.hash.startsWith('#sync=')) return applySyncLink();
    const p = parseHash();
    if (!p.length) { location.replace('#/' + S.meta.cats[0].id); return; }
    if (p[0] === 'cellar') { closeDrawer(true); setCat(null); S.rendered = 'cellar'; document.title = '我的酒櫃｜酒典 Liquor Atlas'; renderCellar(); window.scrollTo(0, 0); return; }
    if (p[0] === 'about') { closeDrawer(true); setCat(null); S.rendered = 'about'; document.title = '資料說明｜酒典 Liquor Atlas'; renderAbout(); window.scrollTo(0, 0); return; }
    const cat = S.meta.cats.find(c => c.id === p[0]);
    if (!cat) { location.replace('#/' + S.meta.cats[0].id); return; }
    const changed = !S.cat || S.cat.id !== cat.id;
    setCat(cat);
    if (p[1] === 'mix') {
      closeDrawer(true);
      document.title = cat.zh + '調酒指南｜酒典 Liquor Atlas';
      if (S.rendered !== cat.id + ':mix') { S.rendered = cat.id + ':mix'; await renderMix(cat); window.scrollTo(0, 0); }
      return;
    }
    document.title = cat.zh + '推薦酒款與台灣比價｜酒典 Liquor Atlas';
    if (S.rendered !== cat.id + ':list') {
      if (changed || !S.f) S.f = newFilter();
      S.rendered = cat.id + ':list';
      await renderList(cat);
      if (!(p[1] === 'b')) window.scrollTo(0, 0);
    }
    if (p[1] === 'b' && p[2]) openBottle(p[2]); else closeDrawer(true);
  }

  // ---------------------------------------------------------------- list view
  function headHTML(cat, which) {
    return `<div class="page-head">
      <div><p class="en">${esc(cat.en)}</p><h1>${esc(cat.zh)}${which === 'mix' ? '調酒指南' : ''}</h1>
      <p class="lede">${esc(which === 'mix' ? '基酒怎麼選、用什麼手法調、經典比例與完整酒譜。' : (cat.lede || ''))}</p></div>
      <nav class="seg" aria-label="頁面切換">
        <a id="seg-list" href="#/${esc(cat.id)}"${which === 'list' ? ' aria-current="page"' : ''}>推薦酒款</a>
        <a id="seg-mix" href="#/${esc(cat.id)}/mix"${which === 'mix' ? ' aria-current="page"' : ''}>調酒指南</a>
      </nav></div>`;
  }
  async function renderList(cat) {
    const view = $('#view');
    view.innerHTML = `<div class="wrap">${headHTML(cat, 'list')}<div class="skeleton">載入 ${esc(cat.zh)} 酒款資料…</div></div>`;
    let d;
    try { d = await loadCat(cat.id); } catch (e) { view.innerHTML = `<div class="wrap">${headHTML(cat, 'list')}<div class="empty">這個酒種的資料還在整理中，請稍後再來。</div></div>`; return; }
    if (S.rendered !== cat.id + ':list') return;
    const f = S.f, items = d.items;
    const countries = {}; const types = {};
    for (const b of items) { countries[b.country] = (countries[b.country] || 0) + 1; types[b.type] = (types[b.type] || 0) + 1; }
    const typeList = (cat.types || []).filter(t => types[t]).concat(Object.keys(types).filter(t => !(cat.types || []).includes(t)));
    const nb = bands(cat).length + 1;
    view.innerHTML = `<div class="wrap">${headHTML(cat, 'list')}
      <div class="toolbar">
        <input id="q" class="field" type="search" placeholder="搜尋酒名、酒廠、產區、風味…" autocomplete="off" aria-label="搜尋酒款" value="${esc(f.q)}">
        <select id="sort" class="field" aria-label="排序">
          <option value="rank">推薦排名</option><option value="twasc">台灣售價 低→高</option><option value="twdesc">台灣售價 高→低</option>
          <option value="intlasc">國外參考價 低→高</option><option value="abv">酒精濃度 高→低</option><option value="name">名稱 A→Z</option>
        </select>
        <button id="btn-filter" class="btn" aria-expanded="false" aria-controls="filters">篩選 <span id="fcount" class="badge" hidden></span></button>
      </div>
      <section id="filters" class="filters" hidden>
        <div><h4>類型</h4><div class="chips" id="f-types">${typeList.map(t => `<button class="chip" data-type="${esc(t)}" aria-pressed="false">${esc(t)}<small>${types[t]}</small></button>`).join('')}</div></div>
        <div><h4>價位（台灣售價；未查到時以國外參考價換算）</h4><div class="chips" id="f-bands">${Array.from({ length: nb }, (_, i) => `<button class="chip" data-band="${i}" aria-pressed="false">${esc(bandLabel(cat, i))}</button>`).join('')}</div></div>
        <div><h4>國家／地區</h4><select id="f-country" class="field" aria-label="國家或地區" style="max-width:260px"><option value="">全部</option>${Object.entries(countries).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<option value="${esc(c)}">${esc(c)}（${n}）</option>`).join('')}</select></div>
        <div><h4>狀態</h4><div class="chips" id="f-flags">
          <button class="chip" data-flag="tw" aria-pressed="false">有台灣售價</button>
          <button class="chip" data-flag="verified" aria-pressed="false">售價已查證</button>
          <button class="chip" data-flag="untried" aria-pressed="false">還沒喝過</button>
          <button class="chip" data-flag="finished" aria-pressed="false">已喝完</button>
          <button class="chip" data-flag="owned" aria-pressed="false">庫存中</button>
          <button class="chip" data-flag="wish" aria-pressed="false">想買</button>
        </div></div>
        <div><button id="f-reset" class="btn small ghost">清除篩選</button></div>
      </section>
      <div class="result-meta"><span id="rcount"></span><span>${esc(cat.asof || '')}</span></div>
      <div id="list" class="list"></div>
    </div>`;
    $('#sort').value = f.sort;
    $('#q').addEventListener('input', e => { f.q = e.target.value.trim().toLowerCase(); f.shown = 40; paintList(); });
    $('#sort').addEventListener('change', e => { f.sort = e.target.value; f.shown = 40; paintList(); });
    $('#btn-filter').addEventListener('click', () => { f.open = !f.open; syncFilterUI(); });
    $('#f-types').addEventListener('click', e => { const b = e.target.closest('[data-type]'); if (!b) return; const t = b.dataset.type; f.types.has(t) ? f.types.delete(t) : f.types.add(t); f.shown = 40; syncFilterUI(); paintList(); });
    $('#f-bands').addEventListener('click', e => { const b = e.target.closest('[data-band]'); if (!b) return; const i = +b.dataset.band; f.band = f.band === i ? -1 : i; f.shown = 40; syncFilterUI(); paintList(); });
    $('#f-flags').addEventListener('click', e => { const b = e.target.closest('[data-flag]'); if (!b) return; const t = b.dataset.flag; f.flags.has(t) ? f.flags.delete(t) : f.flags.add(t); f.shown = 40; syncFilterUI(); paintList(); });
    $('#f-country').addEventListener('change', e => { f.country = e.target.value; f.shown = 40; syncFilterUI(); paintList(); });
    $('#f-reset').addEventListener('click', () => { const q = f.q, o = f.open; Object.assign(f, newFilter(), { q, open: o }); $('#f-country').value = ''; $('#sort').value = 'rank'; syncFilterUI(); paintList(); });
    $('#list').addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.parentNode) t.parentNode.innerHTML = GLYPH; }, true);
    $('#list').addEventListener('click', e => { if (e.target.closest('#more')) { f.shown += 60; paintList(); } else if (e.target.closest('a.row')) S.drawerPushed = true; });
    syncFilterUI(); paintList();
  }
  function syncFilterUI() {
    const f = S.f; if (!$('#filters')) return;
    $('#filters').hidden = !f.open; $('#btn-filter').setAttribute('aria-expanded', String(f.open));
    $$('#f-types .chip').forEach(b => b.setAttribute('aria-pressed', String(f.types.has(b.dataset.type))));
    $$('#f-bands .chip').forEach(b => b.setAttribute('aria-pressed', String(f.band === +b.dataset.band)));
    $$('#f-flags .chip').forEach(b => b.setAttribute('aria-pressed', String(f.flags.has(b.dataset.flag))));
    const n = f.types.size + (f.band >= 0 ? 1 : 0) + f.flags.size + (f.country ? 1 : 0);
    const c = $('#fcount'); c.textContent = n; c.hidden = !n;
  }
  function filtered() {
    const f = S.f, cat = S.cat, items = S.data[cat.id].items, st = Store.statusMap();
    const terms = f.q ? f.q.split(/\s+/) : [];
    let out = items.filter(b => {
      if (terms.length && !terms.every(t => b._s.includes(t))) return false;
      if (f.types.size && !f.types.has(b.type)) return false;
      if (f.country && b.country !== f.country) return false;
      if (f.band >= 0 && !inBand(cat, f.band, b._ref)) return false;
      if (f.flags.has('tw') && b._tw == null) return false;
      if (f.flags.has('verified') && !(b.tw && b.tw.status === 'v' && b._tw != null)) return false;
      const s = st[b.id] || '';
      if (f.flags.has('untried') && (s === 'finished' || Store.byBottle(b.id).some(e => e.status === 'finished'))) return false;
      const want = ['finished', 'owned', 'wish'].filter(x => f.flags.has(x));
      if (want.length && !Store.byBottle(b.id).some(e => want.includes(e.status))) return false;
      return true;
    });
    const big = 1e15;
    const cmp = {
      rank: (a, b) => a.rank - b.rank,
      twasc: (a, b) => (a._tw ?? big) - (b._tw ?? big) || a.rank - b.rank,
      twdesc: (a, b) => (b._tw ?? -1) - (a._tw ?? -1) || a.rank - b.rank,
      intlasc: (a, b) => (a._intl ?? big) - (b._intl ?? big) || a.rank - b.rank,
      abv: (a, b) => (b.abv ?? -1) - (a.abv ?? -1) || a.rank - b.rank,
      name: (a, b) => String(a.name).localeCompare(String(b.name), 'en')
    }[f.sort] || ((a, b) => a.rank - b.rank);
    if (f.sort !== 'rank') out = out.slice().sort(cmp);
    return { out, st };
  }
  const BADGE = { v: ['v', '已查證'], s: ['a', '搜尋結果'], a: ['a', '自動比對'] };
  const badge = st => { const x = BADGE[st] || BADGE.a; return `<span class="vbadge ${x[0]}">${x[1]}</span>`; };
  function priceHTML(b) {
    let h = '';
    if (b._tw != null) {
      const o = b.tw.offers[0];
      h += `<div class="tw num"><small>NT$</small>${fmt(o.price)}</div><div class="pf">${esc(pfName(o.pf))}${badge(b.tw.status)}${o.note ? `<span class="muted"> ${esc(o.note)}</span>` : ''}</div>`;
    } else {
      h += `<div class="none">${b.tw && b.tw.ask && b.tw.ask.length ? '台灣有售・需詢價' : (b.tw ? '台灣未查到標價' : '台灣售價未查')}</div>`;
    }
    if (b.intl && typeof b.intl.amt === 'number') {
      h += `<div class="intl">${esc(b.intl.mkt || '國外')} ${esc(SYM[b.intl.cur] || (b.intl.cur + ' '))}${fmt(b.intl.amt)}${b._intl != null && b.intl.cur !== 'TWD' ? ' ≈ NT$' + fmt(b._intl) : ''}</div>`;
    }
    return h;
  }
  function rowHTML(b, st) {
    const cat = S.cat, s = st[b.id] || '';
    const meta = [b.type, b.region || b.country, b.abv != null ? b.abv + '%' : '', b.age].filter(Boolean);
    const img = b.tw && b.tw.img ? `<img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(safeUrl(b.tw.img))}" alt="">` : GLYPH;
    return `<a class="row" id="row-${esc(b.id)}" href="#/${esc(cat.id)}/b/${esc(b.id)}">
      <span class="rk${b.rank <= 3 ? ' top' : ''}">${b.rank}</span>
      <span class="thumb">${img}</span>
      <span class="main"><span class="zh">${esc(b.zh || b.name)}</span>${b.zh ? `<span class="en" style="display:block">${esc(b.name)}</span>` : ''}
        <span class="meta" style="display:block">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</span>
        <span class="tags">${(b.tags || []).slice(0, 5).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</span></span>
      <span class="price">${priceHTML(b)}</span>
      <span class="mark" data-s="${esc(s)}" title="${esc(STATUS[s] || '')}">${MARK[s] || ''}</span>
    </a>`;
  }
  let io;
  function paintList() {
    const list = $('#list'); if (!list || !S.cat || !S.data[S.cat.id]) return;
    const { out, st } = filtered(), f = S.f;
    $('#rcount').textContent = `共 ${out.length} 支` + (out.length !== S.data[S.cat.id].items.length ? `（全部 ${S.data[S.cat.id].items.length} 支）` : '');
    if (!S.data[S.cat.id].items.length) { list.innerHTML = '<div class="empty">這個酒種的推薦名單還在整理中，會陸續補上。' + (S.cat.mix ? '可以先看調酒指南。' : '') + '</div>'; return; }
    if (!out.length) { list.innerHTML = '<div class="empty">沒有符合條件的酒款，試試放寬篩選。</div>'; return; }
    const show = out.slice(0, f.shown);
    list.innerHTML = show.map(b => rowHTML(b, st)).join('') + (out.length > show.length ? `<button id="more" class="more">顯示更多（還有 ${out.length - show.length} 支）</button>` : '');
    if (io) io.disconnect();
    const more = $('#more');
    if (more && 'IntersectionObserver' in window) {
      io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { f.shown += 60; paintList(); } }, { rootMargin: '600px' });
      io.observe(more);
    }
  }

  // ---------------------------------------------------------------- drawer
  function findBottle(id) { const d = S.cat && S.data[S.cat.id]; return d ? d.items.find(b => b.id === id) : null; }
  function searchLinks(b) {
    const q = (b.zh || b.name || '').trim(), q2 = (b.name || '').trim();
    const links = [];
    for (const p of S.meta.platforms || []) if (p.search) links.push([p.name, p.search.replace('{q}', encodeURIComponent(p.q === 'en' ? q2 : q))]);
    links.push(['Google 搜尋價格', 'https://www.google.com/search?q=' + encodeURIComponent(q + ' 價格 台灣')]);
    links.push(['Google 圖片（價目表／DM）', 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q + ' 價格')]);
    if (q2 && q2 !== q) links.push(['國外行情 Wine-Searcher', 'https://www.wine-searcher.com/find/' + encodeURIComponent(q2)]);
    return links.map(([n, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(n)}</a>`).join('');
  }
  function openBottle(id) {
    const b = findBottle(id), cat = S.cat;
    if (!b) { closeDrawer(true); return; }
    const dr = $('#drawer'), sc = $('#scrim');
    const axes = cat.axes || [];
    const facts = [['類型', b.type], ['國家／產區', [b.country, b.region].filter(Boolean).join('・')], ['酒廠', b.producer], ['酒精濃度', b.abv != null ? b.abv + '%' : ''], ['年份／年數', b.age], ['容量', b.vol ? b.vol + ' ml' : '']]
      .concat(Object.entries(b.specs || {})).filter(x => x[1] != null && String(x[1]).trim() !== '');
    const tw = b.tw && b.tw.offers && b.tw.offers.length ? b.tw : null;
    let twHTML;
    const askRows = ((b.tw && b.tw.ask) || []).map(x => `<tr><td>${esc(pfName(x.pf))}<span class="nm">${esc(x.name || '')}</span></td><td class="muted" style="font-weight:400">需詢價</td><td><a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener noreferrer">商品頁</a></td></tr>`).join('');
    if (tw) {
      const o = tw.offers[0];
      twHTML = `<div class="best"><div><div class="p num"><small>NT$</small>${fmt(o.price)}</div>
          <div class="w">${esc(pfName(o.pf))}${o.note ? '・' + esc(o.note) : ''}${badge(tw.status)}</div></div>
          <a class="btn primary" href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener noreferrer">前往商品頁</a></div>
        <p class="callout" style="margin-top:10px">${{ v: '已逐一比對店家商品名稱與規格', s: '這個價格來自網路搜尋摘要，未能在來源頁面上確認，僅供參考', a: '由程式依品名自動比對，尚未逐一確認' }[tw.status] || ''}；查價日期 ${esc(tw.date || '')}。這是已搜尋平台中的最低公開標價，實際售價、庫存與年份批次請以店家為準。</p>
        ${tw.offers.length > 1 || askRows ? `<table class="offers"><tbody>${tw.offers.map(x => `<tr><td>${esc(pfName(x.pf))}${x.note ? `<span class="muted">・${esc(x.note)}</span>` : ''}<span class="nm">${esc(x.name || '')}</span></td><td>NT$${fmt(x.price)}</td><td><a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener noreferrer">商品頁</a></td></tr>`).join('')}${askRows}</tbody></table>` : ''}`;
    } else {
      const why = !b.tw ? '這支酒尚未查證台灣售價。' : b.tw.status === 'c' ? '已比對各平台商品目錄，沒有收錄這支酒；尚未另做網路搜尋。' : '已比對各平台目錄並上網搜尋，沒有找到公開標價（可能未進口、缺貨或僅門市詢價）。';
      twHTML = `<p class="callout">${why}${b.tw && b.tw.remark ? esc('（' + b.tw.remark + '）') : ''}可用下方連結直接到各平台搜尋。</p>${askRows ? `<table class="offers"><tbody>${askRows}</tbody></table>` : ''}`;
    }
    const intl = b.intl && typeof b.intl.amt === 'number'
      ? `<div class="intlbox"><span>${esc(b.intl.mkt || '國外')}一般零售價</span><b class="num">${esc(SYM[b.intl.cur] || (b.intl.cur + ' '))}${fmt(b.intl.amt)}</b>${b._intl != null && b.intl.cur !== 'TWD' ? `<span class="muted">≈ NT$${fmt(b._intl)}（匯率換算，未含關稅與酒稅）</span>` : ''}</div><p class="callout" style="margin-top:8px">國外參考價為編輯整理的約略行情，未逐筆查證。</p>`
      : '<p class="muted">沒有可靠的國外參考價。</p>';
    $('#drawer-body').innerHTML = `
      <div class="hero"><div>
        <p class="rankline">${esc(cat.zh)}推薦 第 ${b.rank} 名</p>
        <h2 id="drawer-title">${esc(b.zh || b.name)}</h2>
        ${b.zh ? `<p class="en">${esc(b.name)}</p>` : ''}${b.local && b.local !== b.zh ? `<p class="local">${esc(b.local)}</p>` : ''}
        <div class="tags" style="margin-top:12px">${(b.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>${tw && tw.img ? `<figure><a href="${esc(safeUrl(tw.offers[0].url))}" target="_blank" rel="noopener noreferrer"><img id="hero-img" referrerpolicy="no-referrer" src="${esc(safeUrl(tw.img))}" alt="${esc(b.zh || b.name)} 商品圖"></a><figcaption>圖片來源：${esc(pfName(tw.imgPf || tw.offers[0].pf))}</figcaption></figure>` : ''}</div>
      <section class="sec"><h3>價格</h3>
        <h4 style="font:700 13px var(--sans);margin-bottom:8px">台灣售價</h4>${twHTML}
        <div class="searchlinks">${searchLinks(b)}</div>
        <h4 style="font:700 13px var(--sans);margin:18px 0 8px">國外參考價</h4>${intl}
      </section>
      <section class="sec"><h3>我的紀錄</h3><div id="logbox"></div></section>
${b.pending ? `<section class="sec"><h3>酒款資料</h3><dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><p class="callout" style="margin-top:14px">這支酒的品飲筆記與詳細規格還在整理中，會陸續補上。</p><p style="margin-top:10px"><a class="linkish" href="#/${esc(cat.id)}/mix">看${esc(cat.zh)}調酒指南 →</a></p></section>` : `      <section class="sec"><h3>品飲筆記</h3>
        <div class="notes"><div><b>香氣</b><p>${esc(b.nose)}</p></div><div><b>口感</b><p>${esc(b.palate)}</p></div><div><b>尾韻</b><p>${esc(b.finish)}</p></div></div>
        ${axes.length && b.profile ? `<div class="bars">${axes.map((a, i) => `<div class="bar"><span>${esc(a)}</span><i style="--v:${Number(b.profile[i]) || 0}"></i><span class="num">${Number(b.profile[i]) || '–'}</span></div>`).join('')}</div>` : ''}
      </section>
      <section class="sec"><h3>酒款資料</h3><dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>
      <section class="sec"><h3>推薦與飲用</h3><div class="prose">
        ${b.why ? `<p><b>推薦理由　</b>${esc(b.why)}</p>` : ''}${b.serve ? `<p><b>飲用建議　</b>${esc(b.serve)}</p>` : ''}${b.pair ? `<p><b>餐搭　</b>${esc(b.pair)}</p>` : ''}
        ${b.note ? `<p class="callout">${esc(b.note)}</p>` : ''}${b.conf === 'low' ? '<p class="callout">這筆資料的把握度較低，規格請再自行確認。</p>' : ''}
        <p><a class="linkish" href="#/${esc(cat.id)}/mix">看${esc(cat.zh)}調酒指南 →</a></p>
      </div></section>`}`;
    $('#drawer-crumb').textContent = cat.zh + '・' + (b.type || '');
    const hi = $('#hero-img'); if (hi) hi.addEventListener('error', () => { const fg = hi.closest('figure'); if (fg) fg.remove(); });
    dr.dataset.bid = b.id;
    paintLog(b.id);
    if (!dr.classList.contains('open')) { S.lastFocus = document.activeElement; }
    dr.hidden = false; sc.hidden = false;
    requestAnimationFrame(() => { dr.classList.add('open'); sc.classList.add('open'); });
    dr.scrollTop = 0; document.body.style.overflow = 'hidden';
    $('#drawer-close').focus({ preventScroll: true });
  }
  function closeDrawer(silent) {
    const dr = $('#drawer'), sc = $('#scrim');
    if (!dr || dr.hidden) return;
    dr.classList.remove('open'); sc.classList.remove('open'); document.body.style.overflow = '';
    setTimeout(() => { if (!dr.classList.contains('open')) { dr.hidden = true; sc.hidden = true; } }, 260);
    if (S.lastFocus && S.lastFocus.focus && document.contains(S.lastFocus)) S.lastFocus.focus({ preventScroll: true });
    if (!silent && S.cat) {
      if (S.drawerPushed) { S.drawerPushed = false; history.back(); }
      else location.hash = '#/' + S.cat.id;
    }
  }

  // ---------------------------------------------------------------- log UI
  function entryInfo(e) {
    const a = [];
    if (e.buyDate) a.push('購入 ' + e.buyDate);
    if (e.buyPrice) a.push('NT$' + fmt(e.buyPrice));
    if (e.buyPlace) a.push(e.buyPlace);
    if (e.finishDate) a.push('喝完 ' + e.finishDate);
    if (e.rebuy) a.push({ yes: '會回購', maybe: '也許回購', no: '不回購' }[e.rebuy] || '');
    return a.filter(Boolean).join('・');
  }
  const starsText = n => n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '';
  function entryHTML(e, withName) {
    return `<div class="entry" data-eid="${esc(e.eid)}">
      <div class="top">${withName ? '' : ''}<span class="st" data-s="${esc(e.status)}">${esc(STATUS[e.status] || e.status)}</span>
        ${e.rating ? `<span style="color:hsl(40 90% 45%);letter-spacing:1px" aria-label="評分 ${e.rating} 顆星">${starsText(e.rating)}</span>` : ''}
        <span class="acts">${e.status !== 'finished' ? `<button class="btn small" data-act="finish">喝完了</button>` : ''}<button class="btn small ghost" data-act="edit">編輯</button><button class="btn small ghost danger" data-act="del">刪除</button></span></div>
      ${entryInfo(e) ? `<div class="info">${esc(entryInfo(e))}</div>` : ''}${e.notes ? `<div class="txt">${esc(e.notes)}</div>` : ''}</div>`;
  }
  function formHTML(e) {
    const s = e.status;
    return `<form class="logform" id="logform" data-eid="${esc(e.eid || '')}">
      <label>狀態<select class="field" name="status"><option value="wish">想買</option><option value="owned">已購入（庫存中）</option><option value="finished">喝完了</option></select></label>
      <div data-for="owned finished" class="two">
        <label>購買日期<input class="field" type="date" name="buyDate" value="${esc(e.buyDate || '')}"></label>
        <label>購買價格（NT$）<input class="field" type="number" inputmode="numeric" min="0" name="buyPrice" value="${esc(e.buyPrice || '')}"></label>
      </div>
      <label data-for="owned finished">購買通路<input class="field" type="text" name="buyPlace" value="${esc(e.buyPlace || '')}" placeholder="例：酒條通 板橋店"></label>
      <div data-for="finished" class="two">
        <label>喝完日期<input class="field" type="date" name="finishDate" value="${esc(e.finishDate || '')}"></label>
        <label>回購意願<select class="field" name="rebuy"><option value="">未填</option><option value="yes">會回購</option><option value="maybe">也許</option><option value="no">不回購</option></select></label>
      </div>
      <label data-for="finished">評分<span class="stars" id="stars">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-star="${i}" aria-label="${i} 顆星" aria-pressed="${(e.rating || 0) >= i}">★</button>`).join('')}</span></label>
      <label>筆記<textarea class="field" name="notes" rows="3" placeholder="${s === 'wish' ? '想買的原因、目標價…' : '香氣、口感、搭什麼好喝、下次怎麼喝…'}">${esc(e.notes || '')}</textarea></label>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn small ghost" id="log-cancel">取消</button><button class="btn small primary" type="submit">儲存紀錄</button></div>
    </form>`;
  }
  function wireForm(root, e, onSave, onCancel) {
    const form = $('#logform', root);
    let rating = e.rating || 0;
    form.status.value = e.status; if (form.rebuy) form.rebuy.value = e.rebuy || '';
    const vis = () => $$('[data-for]', form).forEach(x => { x.hidden = !x.dataset.for.split(' ').includes(form.status.value); });
    vis();
    form.status.addEventListener('change', () => {
      if (form.status.value === 'finished' && !form.finishDate.value) form.finishDate.value = today();
      if (form.status.value === 'owned' && !form.buyDate.value) form.buyDate.value = today();
      vis();
    });
    $('#stars', form).addEventListener('click', ev => { const b = ev.target.closest('[data-star]'); if (!b) return; const n = +b.dataset.star; rating = rating === n ? 0 : n; $$('[data-star]', form).forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.star <= rating))); });
    $('#log-cancel', form).addEventListener('click', onCancel);
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const st = form.status.value;
      const out = Object.assign({}, e, {
        eid: e.eid || uid(), status: st, notes: form.notes.value.trim(),
        buyDate: st === 'wish' ? '' : form.buyDate.value, buyPrice: st === 'wish' ? '' : (form.buyPrice.value ? Number(form.buyPrice.value) : ''),
        buyPlace: st === 'wish' ? '' : form.buyPlace.value.trim(),
        finishDate: st === 'finished' ? form.finishDate.value : '', rating: st === 'finished' ? rating : 0, rebuy: st === 'finished' ? form.rebuy.value : ''
      });
      onSave(out);
    });
  }
  function paintLog(bid, editing) {
    const box = $('#logbox'); if (!box) return;
    const b = findBottle(bid); if (!b) return;
    const es = Store.byBottle(bid);
    const base = { bid, cat: S.cat.id, name: b.name, zh: b.zh || '' };
    let h = `<div class="logacts">
      <button class="btn" data-new="wish">♡ 想買</button><button class="btn" data-new="owned">◆ 已購入</button><button class="btn primary" data-new="finished">✓ 喝完了</button></div>`;
    if (editing) h += formHTML(editing);
    h += es.length ? `<div class="entries">${es.map(e => entryHTML(e)).join('')}</div>` : (editing ? '' : '<p class="muted" style="margin-top:10px;font-size:13px">還沒有紀錄。買了或喝完之後在這裡記一筆，會出現在「我的酒櫃」。</p>');
    box.innerHTML = h;
    const repaint = () => { paintLog(bid); const row = document.getElementById('row-' + bid); if (row) { const st = Store.statusMap(); row.outerHTML = rowHTML(b, st); } };
    if (editing) wireForm(box, editing, out => { Store.upsert(out); toast('已儲存紀錄'); repaint(); }, () => paintLog(bid));
    box.onclick = ev => {
      const nb = ev.target.closest('[data-new]');
      if (nb) {
        const st = nb.dataset.new;
        const owned = st === 'finished' ? es.find(e => e.status === 'owned') : null;
        const wish = st === 'owned' ? es.find(e => e.status === 'wish') : null;
        const src = owned || wish;
        const e = src ? Object.assign({}, src, { status: st }) : Object.assign({ status: st }, base);
        if (st === 'finished' && !e.finishDate) e.finishDate = today();
        if (st === 'owned' && !e.buyDate) e.buyDate = today();
        if (st === 'wish' && !src) { Store.upsert(Object.assign({ eid: uid(), notes: '' }, e)); toast('已加入想買清單'); repaint(); return; }
        paintLog(bid, e); const f = $('#logform'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const ab = ev.target.closest('[data-act]'); if (!ab) return;
      const eid = ab.closest('[data-eid]').dataset.eid, e = Store.entries[eid]; if (!e) return;
      if (ab.dataset.act === 'del') { if (confirm('確定刪除這筆紀錄？')) { Store.remove(eid); toast('已刪除'); repaint(); } }
      else if (ab.dataset.act === 'edit') paintLog(bid, Object.assign({}, e));
      else if (ab.dataset.act === 'finish') paintLog(bid, Object.assign({}, e, { status: 'finished', finishDate: e.finishDate || today() }));
    };
  }

  // ---------------------------------------------------------------- cellar
  let cellarTab = 'all';
  function renderCellar(editing) {
    const view = $('#view'), all = Store.live().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const n = s => all.filter(e => e.status === s).length;
    const spend = all.reduce((t, e) => t + (Number(e.buyPrice) || 0), 0);
    const rated = all.filter(e => e.rating);
    const shown = cellarTab === 'all' ? all : all.filter(e => e.status === cellarTab);
    const catName = id => { const c = S.meta.cats.find(x => x.id === id); return c ? c.zh : '自訂'; };
    view.innerHTML = `<div class="wrap">
      <div class="page-head"><div><p class="en">My Cellar</p><h1>我的酒櫃</h1><p class="lede">想買的、買了還沒喝完的、已經喝完的，都記在這裡。在任何酒款頁按「喝完了」就能新增。</p></div></div>
      <div class="stats">
        <div class="stat"><b class="num">${n('owned')}</b><span>庫存中</span></div>
        <div class="stat"><b class="num">${n('finished')}</b><span>已喝完</span></div>
        <div class="stat"><b class="num">${n('wish')}</b><span>想買</span></div>
        <div class="stat"><b class="num">${spend ? 'NT$' + fmt(spend) : '–'}</b><span>累計購買金額${rated.length ? '・平均 ' + (rated.reduce((t, e) => t + e.rating, 0) / rated.length).toFixed(1) + ' 星' : ''}</span></div>
      </div>
      <div class="toolbar" style="grid-template-columns:1fr auto">
        <div class="chips" id="cellar-tabs">${[['all', '全部'], ['owned', '庫存中'], ['finished', '已喝完'], ['wish', '想買']].map(([k, v]) => `<button class="chip" data-tab="${k}" aria-pressed="${cellarTab === k}">${v}</button>`).join('')}</div>
        <button id="btn-custom" class="btn small">＋ 記錄清單外的酒</button>
      </div>
      <div id="custom-box"></div>
      <div class="list" id="cellar-list">${shown.length ? shown.map(e => `<div class="cellar-item" data-eid="${esc(e.eid)}">
          <div><div class="zh">${e.custom ? esc(e.zh || e.name) : `<a href="#/${esc(e.cat)}/b/${esc(e.bid)}">${esc(e.zh || e.name)}</a>`}</div>
            <div class="info muted" style="font-size:12.5px">${esc(catName(e.cat))}${e.zh && e.name && e.name !== e.zh ? '・' + esc(e.name) : ''}</div>
            ${entryInfo(e) ? `<div class="info" style="font-size:13px;color:var(--ink-2);margin-top:4px">${esc(entryInfo(e))}</div>` : ''}
            ${e.notes ? `<div class="txt" style="font-size:14px;white-space:pre-wrap;margin-top:4px">${esc(e.notes)}</div>` : ''}</div>
          <div style="text-align:right;display:grid;gap:6px;justify-items:end;align-content:start"><span class="st entry-st" data-s="${esc(e.status)}" style="font-size:11.5px;padding:3px 7px;border-radius:4px;background:var(--bg-2)">${esc(STATUS[e.status])}</span>
            ${e.rating ? `<span style="color:hsl(40 90% 45%)">${starsText(e.rating)}</span>` : ''}
            <span><button class="btn small ghost" data-act="edit">編輯</button><button class="btn small ghost danger" data-act="del">刪除</button></span></div>
        </div>`).join('') : '<div class="empty">這裡還是空的。到任何酒款頁按「想買」「已購入」或「喝完了」就會出現在這裡。</div>'}</div>

      <div style="height:26px"></div>
      <section class="panel" id="sync-panel"><h2>跨裝置同步</h2>
        <p>設定後，紀錄會存到你的私人 GitHub repo，手機、平板、電腦打開這個網頁都看得到同一份。Token 只存在這台裝置的瀏覽器，不會上傳到這個網站。</p>
        <div class="rowf">
          <label style="display:grid;gap:4px;font-size:12px;color:var(--ink-3)">私人 repo（擁有者/名稱）<input id="sync-repo" class="field" type="text" autocomplete="off" spellcheck="false" value="${esc(Sync.cfg.repo)}"></label>
          <label style="display:grid;gap:4px;font-size:12px;color:var(--ink-3)">Fine-grained Token<input id="sync-token" class="field" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" value="${esc(Sync.cfg.token)}"></label>
        </div>
        <div class="acts"><button id="sync-save" class="btn primary small">儲存並同步</button><button id="sync-link" class="btn small">複製「其他裝置設定連結」</button><button id="sync-clear" class="btn small ghost danger">清除這台裝置的同步設定</button></div>
        <p id="sync-msg" class="status-msg">${esc(Sync.msg)}</p>
        <details style="margin-top:8px"><summary class="linkish" style="cursor:pointer;font-size:13.5px">怎麼建立 Token？</summary>
          <ol style="font-size:13.5px;color:var(--ink-2);padding-left:1.3em;margin:8px 0 0;display:grid;gap:4px">
            <li>開啟 <a class="linkish" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub → Fine-grained tokens → Generate new token</a>。</li>
            <li>Repository access 選 <b>Only select repositories</b>，只勾上面那個私人 repo。</li>
            <li>Permissions → Repository permissions → <b>Contents：Read and write</b>，其他都不用開。</li>
            <li>產生後把 <code>github_pat_…</code> 貼到上面，按「儲存並同步」。</li>
            <li>其他裝置：在這台按「複製其他裝置設定連結」，把連結傳給自己並在該裝置打開一次即可（連結含 Token，請勿外流）。</li>
          </ol></details>
      </section>
      <section class="panel"><h2>備份</h2><p>把所有紀錄匯出成 JSON 檔，或從備份匯入（會與現有紀錄合併）。</p>
        <div class="acts"><button id="btn-export" class="btn small">匯出 JSON</button><button id="btn-import" class="btn small">匯入 JSON</button><input id="file-import" type="file" accept="application/json,.json" hidden></div></section>
    </div>`;
    $$('#cellar-list .entry-st').forEach(x => { const s = x.dataset.s; if (s === 'finished') { x.style.background = 'var(--good-soft)'; x.style.color = 'var(--good)'; } else if (s === 'owned') { x.style.background = 'var(--accent-soft)'; x.style.color = 'var(--accent)'; } });
    $('#cellar-tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { cellarTab = b.dataset.tab; renderCellar(); } };
    const showForm = e => {
      const box = $('#custom-box');
      box.innerHTML = `<div class="panel"><h2>${e.eid ? '編輯紀錄' : '記錄清單外的酒'}</h2>
        ${e.custom || !e.eid ? `<div class="rowf"><label style="display:grid;gap:4px;font-size:12px;color:var(--ink-3)">酒名<input id="c-name" class="field" type="text" value="${esc(e.zh || e.name || '')}" placeholder="例：某某酒莊 2019"></label>
        <label style="display:grid;gap:4px;font-size:12px;color:var(--ink-3)">酒種<select id="c-cat" class="field">${S.meta.cats.map(c => `<option value="${esc(c.id)}">${esc(c.zh)}</option>`).join('')}</select></label></div>` : `<p>${esc(e.zh || e.name)}</p>`}
        ${formHTML(e)}</div>`;
      if ($('#c-cat')) $('#c-cat').value = e.cat || S.meta.cats[0].id;
      wireForm(box, e, out => {
        if ($('#c-name')) {
          const nm = $('#c-name').value.trim(); if (!nm) { toast('請輸入酒名'); return; }
          out.zh = nm; out.name = nm; out.cat = $('#c-cat').value; out.custom = true; if (!out.bid) out.bid = 'custom-' + out.eid;
        }
        Store.upsert(out); toast('已儲存紀錄'); renderCellar();
      }, () => { box.innerHTML = ''; });
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    $('#btn-custom').onclick = () => showForm({ status: 'finished', finishDate: today(), custom: true });
    $('#cellar-list').onclick = ev => {
      const ab = ev.target.closest('[data-act]'); if (!ab) return;
      const eid = ab.closest('[data-eid]').dataset.eid, e = Store.entries[eid]; if (!e) return;
      if (ab.dataset.act === 'del') { if (confirm('確定刪除這筆紀錄？')) { Store.remove(eid); toast('已刪除'); renderCellar(); } }
      else showForm(Object.assign({}, e));
    };
    $('#sync-save').onclick = async () => {
      Sync.cfg.repo = $('#sync-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
      Sync.cfg.token = $('#sync-token').value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(Sync.cfg.repo)) { Sync.set('err', 'repo 格式應為「擁有者/名稱」'); return; }
      if (!Sync.cfg.token) { Sync.set('err', '請貼上 Token'); return; }
      Sync.saveCfg(); await Sync.run();
    };
    $('#sync-clear').onclick = () => { if (!confirm('清除這台裝置上的同步設定？（紀錄本身不會刪除）')) return; Sync.cfg.token = ''; Sync.saveCfg(); Sync.set('off', '已清除同步設定，紀錄只存在這台裝置。'); renderCellar(); };
    $('#sync-link').onclick = async () => {
      if (!Sync.enabled()) { Sync.set('err', '請先儲存 repo 與 Token'); return; }
      const link = location.origin + location.pathname + '#sync=' + b64enc(JSON.stringify({ repo: Sync.cfg.repo, token: Sync.cfg.token }));
      try { await navigator.clipboard.writeText(link); toast('已複製設定連結，請只傳給自己'); } catch (e) { prompt('複製這個連結到其他裝置開啟（含 Token，請勿外流）', link); }
    };
    $('#btn-export').onclick = () => {
      const blob = new Blob([JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), entries: Store.entries }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'liquor-atlas-log-' + today() + '.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    $('#btn-import').onclick = () => $('#file-import').click();
    $('#file-import').onchange = async ev => {
      const file = ev.target.files[0]; if (!file) return;
      try { const o = JSON.parse(await file.text()); if (!o || typeof o.entries !== 'object') throw new Error('格式不符'); Store.merge(o); updateCount(); Sync.schedule(); toast('已匯入並合併'); renderCellar(); }
      catch (e) { toast('匯入失敗：' + e.message); }
    };
    if (editing) showForm(editing);
  }
  function applySyncLink() {
    try {
      const o = JSON.parse(b64dec(location.hash.slice(6)));
      if (o && o.repo && o.token) { Sync.cfg.repo = String(o.repo); Sync.cfg.token = String(o.token); Sync.saveCfg(); toast('已套用同步設定'); Sync.run(); }
    } catch (e) { toast('同步連結無效'); }
    history.replaceState(null, '', location.pathname + '#/cellar');
    route();
  }

  // ---------------------------------------------------------------- cocktails
  async function renderMix(cat) {
    const view = $('#view');
    view.innerHTML = `<div class="wrap">${headHTML(cat, 'mix')}<div class="skeleton">載入調酒指南…</div></div>`;
    let m;
    try { m = S.mix[cat.id] || (S.mix[cat.id] = await getJSON('data/mix/' + cat.id + '.json')); }
    catch (e) { view.innerHTML = `<div class="wrap">${headHTML(cat, 'mix')}<div class="empty">這個酒種的調酒指南還在整理中。</div></div>`; return; }
    if (S.rendered !== cat.id + ':mix') return;
    const g = m.guide || {}, rs = m.recipes || [];
    const fams = [...new Set(rs.map(r => r.family).filter(Boolean))];
    const list = v => Array.isArray(v) ? v : (v ? [v] : []);
    const dots = n => `<span class="dots" aria-label="難度 ${n} / 3">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
    view.innerHTML = `<div class="wrap">${headHTML(cat, 'mix')}<div class="mix">
      <section><p class="intro">${esc(g.intro)}</p></section>
      ${list(g.base_guide).length ? `<section><h2>基酒怎麼選 <small>Base</small></h2><table class="tbl"><thead><tr><th>風格</th><th>風味特性</th><th>適合的調製方向</th><th>代表調酒</th></tr></thead><tbody>
        ${list(g.base_guide).map(x => `<tr><td>${esc(x.style)}</td><td>${esc(x.character)}</td><td>${esc(x.best_for)}</td><td>${esc(list(x.examples).join('、'))}</td></tr>`).join('')}</tbody></table></section>` : ''}
      ${list(g.methods).length ? `<section><h2>調製方式 <small>Methods</small></h2><div class="cards">${list(g.methods).map(x => `<article class="card"><h3>${esc(x.name)}</h3><p>${esc(x.when)}</p><ol>${list(x.how).map(s => `<li>${esc(s)}</li>`).join('')}</ol>${x.tips ? `<p class="callout">${esc(x.tips)}</p>` : ''}</article>`).join('')}</div></section>` : ''}
      ${list(g.ratios).length ? `<section><h2>黃金比例 <small>Ratios</small></h2><div class="cards">${list(g.ratios).map(x => `<article class="card"><p class="k">${esc(x.name)}</p><p class="formula">${esc(x.formula)}</p><p>${esc(x.desc)}</p></article>`).join('')}</div></section>` : ''}
      ${rs.length ? `<section><h2>酒譜 <small>${rs.length} Recipes</small></h2>
        <div class="chips" id="fam" style="margin-bottom:14px"><button class="chip" data-fam="" aria-pressed="true">全部</button>${fams.map(f => `<button class="chip" data-fam="${esc(f)}" aria-pressed="false">${esc(f)}</button>`).join('')}</div>
        <div class="cards" id="recipes">${rs.map((r, i) => `<details class="card recipe" id="recipe-${i}" data-fam="${esc(r.family || '')}"><summary>
            <span class="zh">${esc(r.name_zh || r.name)}</span><span class="en">${esc(r.name_zh ? r.name : '')}</span>
            <span class="line"><span>${esc(r.family || '')}</span><span>${esc(r.method || '')}</span><span>酒感 ${esc(r.strength || '–')}</span><span>難度 ${dots(Number(r.difficulty) || 1)}</span></span>
            <span class="line" style="color:var(--ink-2)">${esc(r.taste || '')}</span></summary>
          <div class="body"><table class="ing"><tbody>${list(r.ingredients).map(x => `<tr><td>${esc(x.item)}</td><td>${esc(x.amt)}</td></tr>`).join('')}</tbody></table>
            <p class="line"><span>杯型 ${esc(r.glass || '–')}</span><span>冰 ${esc(r.ice || '–')}</span><span>裝飾 ${esc(r.garnish || '–')}</span></p>
            <ol>${list(r.steps).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
            ${r.base_tip ? `<p class="callout"><b>基酒建議　</b>${esc(r.base_tip)}</p>` : ''}${r.story ? `<p>${esc(r.story)}</p>` : ''}
            ${list(r.variations).length ? `<p><span class="k">變化</span><br>${list(r.variations).map(esc).join('<br>')}</p>` : ''}</div></details>`).join('')}</div></section>` : ''}
      ${list(g.pairing_ingredients).length ? `<section><h2>合拍的副材料 <small>Pairings</small></h2><table class="tbl"><thead><tr><th>材料</th><th>為什麼合拍</th></tr></thead><tbody>${list(g.pairing_ingredients).map(x => `<tr><td>${esc(x.item)}</td><td>${esc(x.why)}</td></tr>`).join('')}</tbody></table></section>` : ''}
      ${list(g.mistakes).length ? `<section><h2>常見錯誤 <small>Pitfalls</small></h2><ul class="checklist">${list(g.mistakes).map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
      ${g.home_bar ? `<section><h2>在家準備 <small>Home Bar</small></h2><div class="cards">
        <article class="card"><p class="k">器具</p><ul>${list(g.home_bar.tools).map(x => `<li>${esc(x)}</li>`).join('')}</ul></article>
        <article class="card"><p class="k">常備副材料</p><ul>${list(g.home_bar.pantry).map(x => `<li>${esc(x)}</li>`).join('')}</ul></article>
        <article class="card"><p class="k">入門基酒</p><ul>${list(g.home_bar.starter_bottles).map(x => `<li>${esc(x)}</li>`).join('')}</ul></article></div></section>` : ''}
      ${g.other_serves ? `<section><h2>調酒之外 <small>Other Serves</small></h2><p class="intro">${esc(g.other_serves)}</p></section>` : ''}
    </div></div>`;
    const fam = $('#fam');
    if (fam) fam.onclick = e => { const b = e.target.closest('[data-fam]'); if (!b) return; $$('#fam .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b))); $$('#recipes .recipe').forEach(x => { x.hidden = !!b.dataset.fam && x.dataset.fam !== b.dataset.fam; }); };
  }

  // ---------------------------------------------------------------- about
  function renderAbout() {
    const m = S.meta, total = m.cats.reduce((t, c) => t + (c.count || 0), 0), priced = m.cats.reduce((t, c) => t + (c.priced || 0), 0);
    $('#view').innerHTML = `<div class="wrap"><div class="page-head"><div><p class="en">About the data</p><h1>資料說明</h1></div></div><div class="about">
      <section class="panel"><h2>這份清單怎麼來的</h2><p>共 ${m.cats.length} 個酒種、${fmt(total)} 支酒。排名是綜合國際競賽、專業評分媒體、社群口碑、性價比與可購得性的「編輯推薦排序」，不是任何官方榜單。酒款規格與品飲描述由 AI 編輯依公開資料整理，可能有誤，重要資訊（年份、酒精度、容量）請以酒標與店家為準。目前已有詳細資料卡的酒款：${fmt(m.cats.reduce((t, c) => t + (c.detailed || 0), 0))} 支，其餘陸續補上。</p></section>
      <section class="panel"><h2>價格標示</h2><ul>
        <li><b>已查證</b>：逐一比對過台灣店家目錄中的商品名稱與規格，顯示已搜尋平台中的最低公開標價與連結。</li>
        <li><b>自動比對</b>：程式依品名從店家目錄嚴格比對出來，尚未逐一確認，仍可能配錯版本、年份或容量。</li>
        <li><b>搜尋結果</b>：價格來自網路搜尋摘要，未能在來源頁面上確認。</li>
        <li><b>未查／未查到</b>：尚未查價，或沒有找到公開標價；可用各平台搜尋連結自行查詢。</li>
        <li><b>國外參考價</b>：整理的約略行情，未逐筆查證；新台幣換算僅為匯率換算（${esc(m.fxDate || '')}），不含關稅與酒稅。</li>
        <li>目前有台灣售價的酒款：${fmt(priced)} 支。查價日期見各酒款頁；價格會變動。</li></ul></section>
      <section class="panel"><h2>已搜尋的台灣平台</h2><table class="offers"><tbody>${(m.platforms || []).map(p => `<tr><td><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a><span class="nm">${esc(p.note || '')}</span></td><td>${p.count ? fmt(p.count) + ' 筆' : '–'}</td><td></td></tr>`).join('')}</tbody></table>
        <p style="margin-top:10px">依菸酒管理法，台灣不能在網路上直接結帳買酒；多數平台是「線上查價／詢價、門市取貨或專人聯繫」。</p></section>
      <section class="panel"><h2>你的紀錄存在哪裡</h2><p>預設只存在這台裝置的瀏覽器。到「我的酒櫃」設定同步後，會存到你自己的私人 GitHub repo。這個網站本身不會收到任何紀錄或 Token。</p></section>
      <p class="muted">資料更新：${esc(m.build || '')}</p></div></div>`;
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    Store.load();
    try { S.meta = await (await fetch('data/meta.json?t=' + Date.now(), { cache: 'no-store' })).json(); }
    catch (e) { $('#view').innerHTML = '<div class="wrap"><div class="empty">資料載入失敗，請重新整理。</div></div>'; return; }
    $('#cat-tabs').innerHTML = S.meta.cats.map(c => `<a class="cat-tab" id="tab-${esc(c.id)}" data-id="${esc(c.id)}" href="#/${esc(c.id)}">${esc(c.zh)}</a>`).join('');
    Sync.load(); updateCount();
    $('#drawer-close').addEventListener('click', () => closeDrawer(false));
    $('#scrim').addEventListener('click', () => closeDrawer(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(false); });
    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Sync.enabled()) Sync.schedule(); });
    if (!localStorage.getItem(LS.age)) {
      const g = $('#gate'); g.hidden = false;
      $('#gate-yes').onclick = () => { localStorage.setItem(LS.age, '1'); g.hidden = true; };
      $('#gate-no').onclick = () => { location.href = 'https://www.google.com/'; };
    }
    await route();
    if (Sync.enabled()) Sync.run();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
