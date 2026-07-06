/* ============================================================
   TV TIME — Watchlist tracker (LCARS Edition, PWA)
   ============================================================ */

const STORAGE_KEY = 'tvtime.v4';
const API_BASE = 'https://api.tvmaze.com';
const EPISODE_CACHE_TTL = 1000 * 60 * 60 * 12;

const state = {
  shows: [],
  watched: {},
  reminders: [],
  notifEnabled: false,
  installDismissed: false,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.shows = data.shows || [];
      state.watched = data.watched || {};
      state.reminders = data.reminders || [];
      state.notifEnabled = !!data.notifEnabled;
      state.installDismissed = !!data.installDismissed;
    }
  } catch (e) { console.warn('load failed', e); }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    shows: state.shows,
    watched: state.watched,
    reminders: state.reminders,
    notifEnabled: state.notifEnabled,
    installDismissed: state.installDismissed,
  }));
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function relativeDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(d); target.setHours(0,0,0,0);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (diff < -1) return `${-diff}d ago`;
  return fmtDate(iso);
}
function startOfToday() { const d = new Date(); d.setHours(0,0,0,0); return d; }
function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').trim();
}

let toastTimer;
function toast(msg, emoji = '✨') {
  const t = $('#toast');
  if (!t) return;
  t.innerHTML = `<span class="emoji">${emoji}</span>${msg}`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

/* ---------- API ---------- */
async function searchShows(q) {
  const r = await fetch(`${API_BASE}/search/shows?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Search failed');
  return (await r.json()).slice(0, 20).map(s => normalizeShow(s.show));
}
async function fetchEpisodes(showId) {
  const r = await fetch(`${API_BASE}/shows/${showId}/episodes`);
  if (!r.ok) throw new Error('Episodes failed');
  return (await r.json()).map(normalizeEpisode);
}
function normalizeShow(s) {
  return {
    id: s.id, name: s.name,
    poster: s.image?.medium || s.image?.original || '',
    premiered: s.premiered || '',
    status: s.status || '',
    summary: stripHtml(s.summary || ''),
    network: s.network?.name || s.webChannel?.name || '',
    genres: s.genres || [],
    type: s.type || '',
    runtime: s.runtime || s.averageRuntime || null,
    rating: s.rating?.average ?? null,
  };
}
function normalizeEpisode(e) {
  return {
    id: e.id, season: e.season, number: e.number,
    name: e.name || '',
    airdate: e.airdate || '',
    airtime: e.airtime || '',
    airstamp: e.airstamp || '',
    summary: stripHtml(e.summary || ''),
  };
}

async function getEpisodes(showId) {
  const cacheKey = `tvtime.ep.${showId}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (Date.now() - parsed.t < EPISODE_CACHE_TTL) return parsed.eps;
  }
  const eps = await fetchEpisodes(showId);
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), eps })); } catch {}
  return eps;
}

/* ---------- ADD / REMOVE ---------- */
function addShow(show) {
  if (state.shows.find(s => s.id === show.id)) {
    toast('Already in archive', '👀'); return false;
  }
  state.shows.unshift(show);
  save();
  toast(`Added ${show.name}`, '🖖');
  const btn = $('#addBtn');
  if (btn) {
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 600);
  }
  refreshAll();
  checkReminders();
  return true;
}
function removeShow(showId) {
  const s = state.shows.find(s => s.id === showId);
  state.shows = state.shows.filter(s => s.id !== showId);
  delete state.watched[showId];
  state.reminders = state.reminders.filter(r => r.showId !== showId);
  save();
  toast(`Removed ${s?.name || 'title'}`, '🗑️');
  refreshAll();
}

/* ---------- WATCHED ---------- */
function toggleWatched(showId, epId) {
  if (!state.watched[showId]) state.watched[showId] = {};
  if (state.watched[showId][epId]) {
    delete state.watched[showId][epId];
  } else {
    state.watched[showId][epId] = true;
    state.reminders.forEach(r => {
      if (r.showId === showId && r.epId === epId) r.status = 'watched';
    });
  }
  save();
  refreshAll();
}

async function catchUpTo(showId, epId) {
  const eps = await getEpisodes(showId);
  const target = eps.find(e => e.id === epId);
  if (!target) return;
  if (!state.watched[showId]) state.watched[showId] = {};
  for (const ep of eps) {
    if (ep.season < target.season) state.watched[showId][ep.id] = true;
    else if (ep.season === target.season && ep.number <= target.number) state.watched[showId][ep.id] = true;
    else break;
  }
  state.reminders.forEach(r => {
    if (r.showId === showId && r.status === 'new') {
      const e = eps.find(x => x.id === r.epId);
      if (!e) return;
      if (e.season < target.season || (e.season === target.season && e.number <= target.number)) {
        r.status = 'watched';
      }
    }
  });
  save();
  toast('Archive synced', '🖖');
  refreshAll();
}

/* ---------- UPCOMING ---------- */
async function renderUpcoming() {
  const list = $('#upcomingList');
  const empty = $('#upcomingEmpty');
  if (!list || !empty) return;
  list.innerHTML = '';

  const items = [];
  await Promise.all(state.shows.map(async show => {
    try {
      const eps = await getEpisodes(show.id);
      const watched = state.watched[show.id] || {};
      const next = eps.find(e => !watched[e.id] && new Date(e.airstamp || e.airdate) >= startOfToday());
      if (next) items.push({ show, episode: next });
    } catch (e) {}
  }));
  items.sort((a, b) => new Date(a.episode.airstamp || a.episode.airdate) - new Date(b.episode.airstamp || b.episode.airdate));

  if (items.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const it of items) list.appendChild(upcomingCard(it.show, it.episode));
  }
  $('#badgeUpcoming').textContent = items.length;
}

function upcomingCard(show, ep) {
  const date = ep.airstamp || ep.airdate;
  const rel = relativeDay(date);
  let pillClass = 'pill-mini';
  if (rel === 'Today') pillClass += ' today';
  else if (rel === 'Tomorrow') pillClass += ' soon';
  else if (rel.includes('ago')) pillClass += ' past';

  const isWatched = state.watched[show.id]?.[ep.id];
  const thumb = show.poster
    ? el('div', { class: 'up-thumb' }, el('img', { src: show.poster, alt: show.name, loading: 'lazy' }))
    : el('div', { class: 'up-thumb' }, show.name.charAt(0));

  return el('div', { class: 'up-card' + (isWatched ? ' is-watched' : '') },
    thumb,
    el('div', { class: 'up-body' },
      el('div', { class: 'up-show' }, (show.network || 'SERIES').toUpperCase()),
      el('div', { class: 'up-ep' }, `S${ep.season} · E${ep.number} — ${ep.name}`),
      el('p', { class: 'up-syn' }, ep.summary || 'No synopsis available.'),
      el('div', { class: 'up-meta' },
        el('span', { class: pillClass }, rel),
        date ? el('span', { class: 'pill-mini' }, fmtDate(date)) : null,
      ),
    ),
    el('button', {
      class: 'watch-btn' + (isWatched ? ' done' : ''),
      'aria-label': 'Toggle watched',
      onClick: () => toggleWatched(show.id, ep.id),
    },
      el('span', { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` })
    )
  );
}

/* ---------- SHOWS GRID ---------- */
function renderShows() {
  const grid = $('#showsGrid');
  const empty = $('#showsEmpty');
  if (!grid || !empty) return;
  grid.innerHTML = '';

  if (state.shows.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const show of state.shows) {
      const total = state.watched[show.id] ? Object.keys(state.watched[show.id]).length : 0;
      const poster = show.poster
        ? el('img', { src: show.poster, alt: show.name, loading: 'lazy' })
        : el('div', { class: 'placeholder' }, show.name.charAt(0));
      const p = el('div', {
        class: 'poster',
        role: 'button',
        tabindex: '0',
        'aria-label': `Open ${show.name}`,
        'data-show-id': show.id,
      },
        poster,
        el('div', { class: 'overlay' }),
        total > 0 ? el('div', { class: 'progress-pill' }, `${total} EP`) : null,
        el('div', { class: 'title' }, show.name),
      );
      // Direct click listener (one-shot per render)
      p.addEventListener('click', () => openDetail(show.id));
      p.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(show.id); }
      });
      grid.appendChild(p);
    }
  }
  $('#badgeShows').textContent = state.shows.length;
}

/* ---------- WATCHED TAB ---------- */
async function renderWatched() {
  const list = $('#watchedList');
  const empty = $('#watchedEmpty');
  if (!list || !empty) return;
  list.innerHTML = '';

  const items = [];
  for (const show of state.shows) {
    const watched = state.watched[show.id] || {};
    const ids = Object.keys(watched);
    if (ids.length === 0) continue;
    try {
      const eps = await getEpisodes(show.id);
      for (const ep of eps) if (watched[ep.id]) items.push({ show, episode: ep });
    } catch (e) {}
  }
  items.sort((a, b) => new Date(b.episode.airstamp || b.episode.airdate || 0) - new Date(a.episode.airstamp || a.episode.airdate || 0));

  if (items.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const it of items.slice(0, 100)) list.appendChild(upcomingCard(it.show, it.episode));
  }
  $('#badgeWatched').textContent = items.length;
}

/* ---------- REMINDERS / ALERTS ---------- */
async function checkReminders() {
  for (const show of state.shows) {
    try {
      const eps = await getEpisodes(show.id);
      const watched = state.watched[show.id] || {};
      const upcoming = eps.filter(e =>
        !watched[e.id] &&
        e.airstamp &&
        new Date(e.airstamp) > new Date(Date.now() - 1000 * 60 * 60 * 24)
      ).slice(0, 2);
      for (const ep of upcoming) {
        const exists = state.reminders.find(r => r.showId === show.id && r.epId === ep.id);
        if (!exists) {
          state.reminders.push({
            id: `${show.id}-${ep.id}`,
            showId: show.id,
            epId: ep.id,
            showName: show.name,
            poster: show.poster,
            epLabel: `S${ep.season}E${ep.number}`,
            epName: ep.name,
            when: ep.airstamp,
            status: 'new',
            createdAt: Date.now(),
          });
        }
      }
    } catch (e) {}
  }
  state.reminders.sort((a, b) => new Date(a.when) - new Date(b.when));
  save();
  renderReminders();
  scheduleBrowserNotifications();
}

function renderReminders() {
  const list = $('#remindersList');
  const empty = $('#remindersEmpty');
  if (!list || !empty) return;
  list.innerHTML = '';

  const active = state.reminders.filter(r => r.status !== 'dismissed');
  const newCount = state.reminders.filter(r => r.status === 'new').length;

  if (active.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const r of active) {
      const isNew = r.status === 'new';
      const when = new Date(r.when);
      const isPast = when < new Date();
      const rel = isPast ? 'AVAILABLE NOW' : `AIRS ${relativeDay(r.when).toUpperCase()}`;
      const thumb = r.poster
        ? el('div', { class: 'rem-thumb' }, el('img', { src: r.poster, alt: r.showName, loading: 'lazy' }))
        : el('div', { class: 'rem-thumb' }, r.showName.charAt(0));

      const card = el('div', { class: 'reminder-card' + (isNew ? ' new' : '') },
        thumb,
        el('div', { class: 'rem-info' },
          el('div', { class: 'rem-show' }, r.showName.toUpperCase()),
          el('div', { class: 'rem-ep' }, `${r.epLabel} — ${r.epName}`),
          el('div', { class: 'rem-when' }, rel),
        ),
        el('div', { class: 'rem-actions' },
          el('button', {
            class: 'rem-btn watch',
            'aria-label': 'Mark watched',
            onClick: () => { toggleWatched(r.showId, r.epId); },
          }, el('span', { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>` })),
          el('button', {
            class: 'rem-btn',
            'aria-label': 'Dismiss',
            onClick: () => { r.status = 'dismissed'; save(); renderReminders(); },
          }, el('span', { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>` })),
        )
      );
      list.appendChild(card);
    }
  }
  $('#badgeReminders').textContent = newCount;

  const btn = $('#enableNotifsBtn');
  if (!btn) return;
  if (state.notifEnabled) {
    btn.textContent = 'NOTIFICATIONS ACTIVE';
    btn.classList.add('done');
  } else {
    btn.textContent = 'ENABLE NOTIFICATIONS';
    btn.classList.remove('done');
  }
}

async function scheduleBrowserNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (window._tvtimeTimers) window._tvtimeTimers.forEach(clearTimeout);
  window._tvtimeTimers = [];

  const now = Date.now();
  for (const r of state.reminders) {
    if (r.status !== 'new') continue;
    const when = new Date(r.when).getTime();
    const alertAt = when - 1000 * 60 * 30;
    if (alertAt <= now) {
      if (when <= now && when > now - 1000 * 60 * 60) {
        try {
          new Notification(`${r.showName} is airing!`, {
            body: `${r.epLabel} — ${r.epName}`,
            icon: r.poster || 'icons/icon-192.png',
            badge: 'icons/icon-192.png',
            tag: r.id,
          });
          r.status = 'notified';
        } catch (e) {}
      }
      continue;
    }
    const delay = alertAt - now;
    if (delay > 2147483647) continue;
    const t = setTimeout(() => {
      try {
        new Notification(`${r.showName} airs in 30 min`, {
          body: `${r.epLabel} — ${r.epName}`,
          icon: r.poster || 'icons/icon-192.png',
          badge: 'icons/icon-192.png',
          tag: r.id,
        });
        r.status = 'notified';
        save();
        renderReminders();
      } catch (e) {}
    }, delay);
    window._tvtimeTimers.push(t);
  }
  save();
}

/* ---------- DETAIL MODAL (full season/episode browse) ---------- */
let currentDetailShowId = null;
let currentDetailSeason = 1;
let cachedDetailEps = [];

async function openDetail(showId) {
  const show = state.shows.find(s => s.id === showId);
  if (!show) return;
  currentDetailShowId = showId;

  const watchedCount = state.watched[showId] ? Object.keys(state.watched[showId]).length : 0;

  const c = $('#detailContent');
  c.innerHTML = `
    <div class="detail-hero">
      <div class="detail-poster">${show.poster
        ? `<img src="${escapeHtml(show.poster)}" alt="${escapeHtml(show.name)}" onerror="this.outerHTML='<span>${escapeHtml(show.name.charAt(0))}</span>'">`
        : escapeHtml(show.name.charAt(0))}</div>
      <div class="detail-info">
        <h2>${escapeHtml(show.name.toUpperCase())}</h2>
        <div class="meta">
          ${show.premiered ? `<span>${escapeHtml(show.premiered.slice(0,4))}</span>` : ''}
          ${show.status ? `<span>${escapeHtml(show.status.toUpperCase())}</span>` : ''}
          ${show.network ? `<span>${escapeHtml(show.network.toUpperCase())}</span>` : ''}
          ${show.runtime ? `<span>${show.runtime}M</span>` : ''}
          ${show.rating ? `<span>★ ${show.rating}</span>` : ''}
          ${watchedCount > 0 ? `<span>${watchedCount} WATCHED</span>` : ''}
        </div>
        <p class="detail-summary">${escapeHtml(show.summary || 'No summary available.')}</p>
      </div>
    </div>
    <div class="detail-actions">
      <button class="btn" id="catchUpBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        I'M CAUGHT UP TO HERE
      </button>
      <button class="btn danger" id="removeShowBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        REMOVE
      </button>
    </div>
    <div class="season-tabs-wrap">
      <button class="icon-btn season-prev" aria-label="Previous season">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <div class="season-scroll" id="seasonScroll"></div>
      <button class="icon-btn season-next" aria-label="Next season">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>
    <div class="detail-section">
      <h3><span id="seasonLabel">SEASON</span><span id="seasonProgress"></span></h3>
      <div class="ep-list" id="epList"><div class="search-status">Loading transmissions…</div></div>
    </div>
  `;

  $('#removeShowBtn').addEventListener('click', () => {
    removeShow(showId);
    closeModal(detailModal);
  });
  $('#catchUpBtn').addEventListener('click', async () => {
    const eps = await getEpisodes(showId);
    const watched = state.watched[showId] || {};
    const lastWatched = eps.filter(e => watched[e.id]).pop();
    let target;
    if (lastWatched) {
      target = lastWatched;
    } else {
      target = eps
        .filter(e => new Date(e.airstamp || e.airdate) <= new Date())
        .pop();
    }
    if (!target) {
      toast('Nothing to catch up to yet', '⚠️');
      return;
    }
    await catchUpTo(showId, target.id);
    openDetail(showId);
  });

  try {
    const eps = await getEpisodes(showId);
    cachedDetailEps = eps;
    const seasons = [...new Set(eps.map(e => e.season))].sort((a, b) => a - b);
    if (seasons.length === 0) {
      $('#epList').innerHTML = '<div class="search-status">No episodes found.</div>';
      openModal(detailModal);
      return;
    }
    const watched = state.watched[showId] || {};
    let targetSeason = seasons[seasons.length - 1];
    for (let i = seasons.length - 1; i >= 0; i--) {
      const s = seasons[i];
      const epsInS = eps.filter(e => e.season === s);
      if (epsInS.some(e => !watched[e.id])) { targetSeason = s; break; }
    }
    currentDetailSeason = targetSeason;
    renderSeasonTabs(seasons, eps);
    renderEpisodesForSeason(showId, currentDetailSeason, eps);

    $('.season-prev').addEventListener('click', () => {
      const idx = seasons.indexOf(currentDetailSeason);
      if (idx > 0) {
        currentDetailSeason = seasons[idx - 1];
        scrollSeasonIntoView();
        renderSeasonTabs(seasons, cachedDetailEps);
        renderEpisodesForSeason(showId, currentDetailSeason, cachedDetailEps);
      }
    });
    $('.season-next').addEventListener('click', () => {
      const idx = seasons.indexOf(currentDetailSeason);
      if (idx < seasons.length - 1) {
        currentDetailSeason = seasons[idx + 1];
        scrollSeasonIntoView();
        renderSeasonTabs(seasons, cachedDetailEps);
        renderEpisodesForSeason(showId, currentDetailSeason, cachedDetailEps);
      }
    });
  } catch (e) {
    $('#epList').innerHTML = '<div class="search-status">Could not load episodes.</div>';
  }
  openModal(detailModal);
}

function scrollSeasonIntoView() {
  const scroll = $('#seasonScroll');
  const active = scroll?.querySelector('.season-tab.active');
  if (active && scroll) {
    const left = active.offsetLeft - 20;
    scroll.scrollTo({ left, behavior: 'smooth' });
  }
}

function renderSeasonTabs(seasons, allEps) {
  const scroll = $('#seasonScroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  const watched = state.watched[currentDetailShowId] || {};
  for (const s of seasons) {
    const epsInSeason = allEps.filter(e => e.season === s);
    const watchedCount = epsInSeason.filter(e => watched[e.id]).length;
    const complete = watchedCount === epsInSeason.length && epsInSeason.length > 0;
    const tab = el('button', {
      class: 'season-tab' + (s === currentDetailSeason ? ' active' : '') + (complete ? ' complete' : ''),
      onClick: () => {
        currentDetailSeason = s;
        scrollSeasonIntoView();
        renderSeasonTabs(seasons, allEps);
        renderEpisodesForSeason(currentDetailShowId, s, allEps);
      },
    },
      el('span', { class: 'st-dot' }),
      `S${s}`,
      el('span', { style: 'opacity:0.6; font-size:9px;' }, `${watchedCount}/${epsInSeason.length}`)
    );
    scroll.appendChild(tab);
  }
  const sl = $('#seasonLabel');
  const sp = $('#seasonProgress');
  if (sl) sl.textContent = `SEASON ${currentDetailSeason}`;
  if (sp) {
    const epsInSeason = allEps.filter(e => e.season === currentDetailSeason);
    const watchedCount = epsInSeason.filter(e => watched[e.id]).length;
    sp.textContent = `${watchedCount}/${epsInSeason.length} WATCHED`;
  }
}

function renderEpisodesForSeason(showId, season, allEps) {
  const list = $('#epList');
  if (!list) return;
  const watched = state.watched[showId] || {};
  const eps = allEps.filter(e => e.season === season).sort((a, b) => a.number - b.number);
  list.innerHTML = '';
  if (eps.length === 0) {
    list.innerHTML = '<div class="search-status">No episodes in this season.</div>';
    return;
  }
  for (const ep of eps) {
    const isWatched = !!watched[ep.id];
    const item = el('div', {
      class: 'ep-item' + (isWatched ? ' watched' : ''),
    });

    const num = el('div', { class: 'ep-num' },
      el('span', { class: 'ep-s' }, 'S'+ep.season),
      el('span', { class: 'ep-e' }, 'E'+ep.number),
    );
    const content = el('div', { class: 'ep-content' },
      el('div', { class: 'ep-title' }, ep.name),
      el('div', { class: 'ep-date' }, ep.airdate ? fmtDate(ep.airdate) : `EPISODE ${ep.number}`),
    );
    const check = el('button', {
      class: 'ep-check' + (isWatched ? ' done' : ''),
      'aria-label': 'Toggle watched',
      onClick: (e) => {
        e.stopPropagation();
        toggleWatched(showId, ep.id);
        renderSeasonTabs([...new Set(cachedDetailEps.map(x => x.season))].sort((a,b)=>a-b), cachedDetailEps);
        renderEpisodesForSeason(showId, currentDetailSeason, cachedDetailEps);
      },
    },
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>' })
    );

    content.addEventListener('click', (e) => {
      if (e.target.closest('.ep-check')) return;
      const existing = item.querySelector('.ep-synopsis');
      if (existing) {
        existing.remove();
        return;
      }
      const syn = el('div', { class: 'ep-synopsis' }, ep.summary || 'No synopsis available.');
      content.appendChild(syn);
    });

    item.appendChild(num);
    item.appendChild(content);
    item.appendChild(check);
    list.appendChild(item);
  }
}

/* ---------- TABS ---------- */
$$('.ltab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.ltab').forEach(t => t.classList.remove('active'));
    $$('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    $('#view-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'reminders') renderReminders();
  });
});

/* ---------- ADD MODAL ---------- */
const addModal = $('#addModal');
$('#addBtn').addEventListener('click', () => openModal(addModal));
addModal.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) closeModal(addModal);
});
const searchInput = $('#searchInput');
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    $('#searchResults').innerHTML = '';
    $('#searchStatus').textContent = 'Begin typing to search…';
    return;
  }
  $('#searchStatus').textContent = 'SEARCHING…';
  searchTimer = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q) {
  try {
    const results = await searchShows(q);
    if (results.length === 0) {
      $('#searchStatus').textContent = 'NO RESULTS — TRY ANOTHER KEYWORD';
      $('#searchResults').innerHTML = '';
      return;
    }
    $('#searchStatus').textContent = `${results.length} RESULT${results.length === 1 ? '' : 'S'} FOUND`;
    const frag = document.createDocumentFragment();
    for (const s of results) {
      const isAdded = state.shows.some(x => x.id === s.id);
      const item = el('div', { class: 'sr-item' },
        s.poster
          ? el('div', { class: 'sr-thumb' }, el('img', { src: s.poster, alt: s.name, loading: 'lazy' }))
          : el('div', { class: 'sr-thumb' }, s.name.charAt(0)),
        el('div', {},
          el('div', { class: 'sr-title' }, s.name),
          el('div', { class: 'sr-meta' }, [s.network, s.premiered?.slice(0,4), s.status].filter(Boolean).join(' · ')),
        ),
        el('button', {
          class: 'sr-add' + (isAdded ? ' added' : ''),
          'aria-label': isAdded ? 'Added' : 'Add',
          onClick: (e) => {
            e.stopPropagation();
            if (isAdded) return;
            if (addShow(s)) {
              e.currentTarget.classList.add('added');
              e.currentTarget.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>';
            }
          },
        },
          isAdded
            ? el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>' })
            : el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' })
        ),
      );
      item.addEventListener('click', () => {
        if (!isAdded) {
          const added = addShow(s);
          if (added) setTimeout(() => closeModal(addModal), 300);
        }
      });
      frag.appendChild(item);
    }
    $('#searchResults').innerHTML = '';
    $('#searchResults').appendChild(frag);
  } catch (e) {
    $('#searchStatus').textContent = 'CONNECTION LOST — RETRY';
  }
}

/* ---------- DETAIL MODAL ---------- */
const detailModal = $('#detailModal');
detailModal.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) closeModal(detailModal);
});

/* ---------- MODAL HELPERS (keyboard-aware) ---------- */
function openModal(m) {
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (m === addModal) {
    setTimeout(() => searchInput.focus({ preventScroll: true }), 300);
    if (window.visualViewport) {
      const onResize = () => {
        const offset = window.innerHeight - window.visualViewport.height;
        const sheet = m.querySelector('.modal-sheet');
        if (sheet) sheet.style.transform = offset > 50 ? `translateY(-${offset}px)` : '';
      };
      window.visualViewport.addEventListener('resize', onResize);
      window.visualViewport.addEventListener('scroll', onResize);
      m._vvHandler = onResize;
      onResize();
    }
  }
}
function closeModal(m) {
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  const sheet = m.querySelector('.modal-sheet, .detail-sheet');
  if (sheet) sheet.style.transform = '';
  if (window.visualViewport && m._vvHandler) {
    window.visualViewport.removeEventListener('resize', m._vvHandler);
    window.visualViewport.removeEventListener('scroll', m._vvHandler);
  }
  if (m === addModal) {
    searchInput.value = '';
    $('#searchResults').innerHTML = '';
    $('#searchStatus').textContent = 'Begin typing to search…';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (addModal.classList.contains('open')) closeModal(addModal);
    if (detailModal.classList.contains('open')) closeModal(detailModal);
  }
});

document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

/* ---------- NOTIFICATIONS BUTTON ---------- */
$('#enableNotifsBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    toast('Notifications not supported', '⚠️');
    return;
  }
  if (Notification.permission === 'granted') {
    state.notifEnabled = !state.notifEnabled;
    save();
    if (!state.notifEnabled && window._tvtimeTimers) {
      window._tvtimeTimers.forEach(clearTimeout);
      window._tvtimeTimers = [];
    } else {
      scheduleBrowserNotifications();
    }
    renderReminders();
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    state.notifEnabled = true;
    toast('Alerts armed', '📡');
    save();
    renderReminders();
    scheduleBrowserNotifications();
  } else {
    toast('Permission denied', '⚠️');
  }
});

/* ---------- PWA: INSTALL PROMPT + SERVICE WORKER ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!state.installDismissed && state.shows.length > 0) {
    $('#installBanner').classList.remove('hidden');
  }
});

$('#installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) {
    toast('Use your browser menu to install', 'ℹ️');
    return;
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') {
    toast('Installed — alerts now fire from your home screen', '🖖');
  }
  deferredPrompt = null;
  $('#installBanner').classList.add('hidden');
});
$('#dismissInstall').addEventListener('click', () => {
  state.installDismissed = true;
  save();
  $('#installBanner').classList.add('hidden');
});
window.addEventListener('appinstalled', () => {
  $('#installBanner').classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ---------- STARDATE ---------- */
function updateStardate() {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  const oneDay = 1000 * 60 * 60 * 24;
  const dayOfYear = Math.floor(diff / oneDay);
  const sd = `${d.getFullYear()}.${String(dayOfYear).padStart(3, '0')}`;
  const elx = $('#stardate');
  if (elx) elx.textContent = `STARDATE ${sd}`;
}

/* ---------- INIT ---------- */
function refreshAll() {
  renderShows();
  renderUpcoming();
  renderWatched();
  renderReminders();
}

load();
updateStardate();
refreshAll();
checkReminders();

setInterval(() => {
  checkReminders();
}, 1000 * 60 * 5);
