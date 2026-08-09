(() => {
  const PX_PER_MIN = 2.5;
  const DAY_COUNT = 7;
  const DAY_WIDTH = 24 * 60 * PX_PER_MIN;

  // start of "today" at local midnight - the left edge of the whole timeline
  const timelineStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const timelineEnd = timelineStart + DAY_COUNT * 24 * 60 * 60 * 1000;

  const els = {
    statusDot: document.getElementById('statusDot'),
    errorBanner: document.getElementById('errorBanner'),
    errorBannerText: document.getElementById('errorBannerText'),
    errorBannerClose: document.getElementById('errorBannerClose'),
    lastSynced: document.getElementById('lastSynced'),
    autoSync: document.getElementById('autoSync'),
    syncBtn: document.getElementById('syncBtn'),
    syncLabel: document.getElementById('syncLabel'),
    settingsBtn: document.getElementById('settingsBtn'),
    recordingsBtn: document.getElementById('recordingsBtn'),
    recordingsBadge: document.getElementById('recordingsBadge'),
    recordingsList: document.getElementById('recordingsList'),
    recSelectAll: document.getElementById('recSelectAll'),
    recDeleteSelected: document.getElementById('recDeleteSelected'),
    recListClose: document.getElementById('recListClose'),
    catFilter: document.getElementById('catFilter'),
    catList: document.getElementById('catList'),
    synopsisPanel: document.getElementById('synopsisPanel'),
    previewPanel: document.getElementById('previewPanel'),
    previewLogo: document.getElementById('previewLogo'),
    previewVideo: document.getElementById('previewVideo'),
    previewHint: document.getElementById('previewHint'),
    progSearch: document.getElementById('progSearch'),
    searchResults: document.getElementById('searchResults'),
    dayChips: document.getElementById('dayChips'),
    jumpNow: document.getElementById('jumpNow'),
    epgBody: document.getElementById('epgBody'),
    epgTimescale: document.getElementById('epgTimescale'),
    epgRows: document.getElementById('epgRows'),
    modal: document.getElementById('settingsModal'),
    cfgHost: document.getElementById('cfgHost'),
    cfgUser: document.getElementById('cfgUser'),
    cfgPass: document.getElementById('cfgPass'),
    cfgError: document.getElementById('cfgError'),
    cfgSave: document.getElementById('cfgSave'),
    cfgCancel: document.getElementById('cfgCancel'),
    cfgPadBefore: document.getElementById('cfgPadBefore'),
    cfgPadAfter: document.getElementById('cfgPadAfter'),
    cfgRecPath: document.getElementById('cfgRecPath'),
    cfgRecError: document.getElementById('cfgRecError'),
    cfgRecSave: document.getElementById('cfgRecSave'),
    cfgRecCancel: document.getElementById('cfgRecCancel'),
    epgSourceSelect: document.getElementById('epgSourceSelect'),
    epgSourceList: document.getElementById('epgSourceList'),
    epgSourceName: document.getElementById('epgSourceName'),
    epgSourceUrl: document.getElementById('epgSourceUrl'),
    epgSourceAdd: document.getElementById('epgSourceAdd'),
    epgSourceError: document.getElementById('epgSourceError'),
    epgCancel: document.getElementById('epgCancel'),
    epgSave: document.getElementById('epgSave'),
  };

  let state = {
    categories: [],
    activeCategoryId: null,
    currentChannel: null,
    currentProgram: null,
    hls: null,
  };

  function showError(message) {
    const text = (message && String(message).trim()) || 'Something went wrong, but no error message was provided. Check docker logs for detail.';
    els.errorBannerText.textContent = text;
    els.errorBanner.style.display = 'flex';
    console.error(text);
  }
  function hideError() {
    els.errorBanner.style.display = 'none';
  }
  els.errorBannerClose.addEventListener('click', hideError);

  // ---------------- helpers ----------------
  function fmtRelative(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - Number(ms);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h < 12 ? 'am' : 'pm';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${m}${ampm}`;
  }

  async function api(path, opts) {
    const res = await fetch('/api' + path, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.json();
  }

  // ---------------- settings / sync ----------------
  async function loadSettings() {
    const s = await api('/settings');
    els.lastSynced.textContent = fmtRelative(s.lastSyncAt);
    els.lastSynced.classList.toggle('fresh', !!s.lastSyncAt);
    els.lastSynced.classList.remove('error');
    els.lastSynced.title = '';
    els.autoSync.value = String(s.autoSyncHours || 0);
    els.statusDot.className = 'dot ' + (s.xcHost ? 'ok' : '');
    if (!s.xcHost) openSettingsModal();
    return s;
  }

  function openSettingsModal(errorMsg) {
    els.cfgError.textContent = errorMsg || '';
    els.modal.classList.add('open');
  }
  function closeSettingsModal() {
    els.modal.classList.remove('open');
    els.cfgError.textContent = '';
    stopRecordingsPoll();
  }

  els.settingsBtn.addEventListener('click', async () => {
    const s = await api('/settings');
    els.cfgHost.value = s.xcHost || '';
    els.cfgUser.value = s.xcUsername || '';
    els.cfgPass.value = '';
    const rec = await api('/settings/recording');
    els.cfgPadBefore.value = rec.padBeforeMin;
    els.cfgPadAfter.value = rec.padAfterMin;
    els.cfgRecPath.textContent = rec.recordingsPath;
    await loadEpgSources();
    switchSettingsTab('xc');
    openSettingsModal();
  });
  els.cfgCancel.addEventListener('click', closeSettingsModal);
  els.cfgRecCancel.addEventListener('click', closeSettingsModal);
  els.epgCancel.addEventListener('click', closeSettingsModal);
  els.recListClose.addEventListener('click', closeSettingsModal);

  document.querySelectorAll('.modal-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.tab));
  });
  function switchSettingsTab(tab) {
    document.querySelectorAll('.modal-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('tabXc').style.display = tab === 'xc' ? 'flex' : 'none';
    document.getElementById('tabEpg').style.display = tab === 'epg' ? 'flex' : 'none';
    document.getElementById('tabRec').style.display = tab === 'rec' ? 'flex' : 'none';
    document.getElementById('tabList').style.display = tab === 'list' ? 'flex' : 'none';
    if (tab === 'list') {
      loadRecordingsList();
      startRecordingsPoll();
    } else {
      stopRecordingsPoll();
    }
  }

  els.cfgRecSave.addEventListener('click', async () => {
    els.cfgRecSave.disabled = true;
    els.cfgRecError.textContent = '';
    try {
      await api('/settings/recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          padBeforeMin: Number(els.cfgPadBefore.value) || 0,
          padAfterMin: Number(els.cfgPadAfter.value) || 0,
        }),
      });
      closeSettingsModal();
    } catch (err) {
      els.cfgRecError.textContent = err.message;
    } finally {
      els.cfgRecSave.disabled = false;
    }
  });

  // ---------------- EPG source tab ----------------
  let epgSourcesCache = { sources: [], activeEpgSourceId: '' };

  async function loadEpgSources() {
    epgSourcesCache = await api('/epg-sources');
    renderEpgSources();
  }

  function renderEpgSources() {
    // dropdown
    const opts = ['<option value="">XC Server (default xmltv.php)</option>']
      .concat(epgSourcesCache.sources.map((s) =>
        `<option value="${s.id}">${escapeHtml(s.name)}</option>`
      ));
    els.epgSourceSelect.innerHTML = opts.join('');
    els.epgSourceSelect.value = epgSourcesCache.activeEpgSourceId || '';

    // list of added sources with delete buttons
    if (epgSourcesCache.sources.length === 0) {
      els.epgSourceList.innerHTML = `<div class="record-note">No custom sources added yet.</div>`;
    } else {
      els.epgSourceList.innerHTML = epgSourcesCache.sources.map((s) => `
        <div class="epg-source-item">
          <div class="es-info">
            <div class="es-name">${escapeHtml(s.name)}</div>
            <div class="es-url">${escapeHtml(s.url)}</div>
          </div>
          <button data-id="${s.id}">Remove</button>
        </div>
      `).join('');
      els.epgSourceList.querySelectorAll('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/epg-sources/${btn.dataset.id}`, { method: 'DELETE' });
            await loadEpgSources();
          } catch (err) {
            els.epgSourceError.textContent = err.message;
          }
        });
      });
    }
  }

  els.epgSourceAdd.addEventListener('click', async () => {
    const name = els.epgSourceName.value.trim();
    const url = els.epgSourceUrl.value.trim();
    els.epgSourceError.textContent = '';
    if (!name || !url) {
      els.epgSourceError.textContent = 'Both a name and a URL are required.';
      return;
    }
    try {
      await api('/epg-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url }),
      });
      els.epgSourceName.value = '';
      els.epgSourceUrl.value = '';
      await loadEpgSources();
    } catch (err) {
      els.epgSourceError.textContent = err.message;
    }
  });

  els.epgSave.addEventListener('click', async () => {
    els.epgSave.disabled = true;
    els.epgSourceError.textContent = '';
    try {
      await api('/epg-sources/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: els.epgSourceSelect.value || null }),
      });
      closeSettingsModal();
      triggerSync();
    } catch (err) {
      els.epgSourceError.textContent = err.message;
    } finally {
      els.epgSave.disabled = false;
    }
  });

  els.cfgSave.addEventListener('click', async () => {
    const xcHost = els.cfgHost.value.trim();
    const xcUsername = els.cfgUser.value.trim();
    const xcPassword = els.cfgPass.value;
    if (!xcHost || !xcUsername || !xcPassword) {
      els.cfgError.textContent = 'All three fields are required.';
      return;
    }
    els.cfgSave.disabled = true;
    els.cfgError.textContent = 'Testing connection...';
    try {
      await api('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xcHost, xcUsername, xcPassword }),
      });
      closeSettingsModal();
      await loadSettings();
      triggerSync();
    } catch (err) {
      els.cfgError.textContent = err.message;
    } finally {
      els.cfgSave.disabled = false;
    }
  });

  els.autoSync.addEventListener('change', async () => {
    await api('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSyncHours: Number(els.autoSync.value) }),
    });
  });

  async function triggerSync() {
    if (els.syncBtn.classList.contains('syncing')) return;
    els.syncBtn.classList.add('syncing');
    els.syncBtn.disabled = true;
    els.syncLabel.textContent = 'Syncing...';
    hideError();
    try {
      await api('/sync', { method: 'POST' });
      await pollSyncUntilDone();
      await loadSettings();
      await loadCategories();
      if (state.activeCategoryId) await loadEpg(state.activeCategoryId);
    } catch (err) {
      els.lastSynced.textContent = 'sync failed';
      els.lastSynced.classList.add('error');
      els.lastSynced.title = err.message || ''; // hover for detail
      showError('Sync failed: ' + (err.message || 'no error message was returned - check docker logs for detail.'));
    } finally {
      els.syncBtn.classList.remove('syncing');
      els.syncBtn.disabled = false;
      els.syncLabel.textContent = 'Sync now';
    }
  }

  function pollSyncUntilDone() {
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const status = await api('/sync/status');
          if (status.running) {
            els.syncLabel.textContent = 'Syncing: ' + (status.phase || '...');
            setTimeout(tick, 1000);
          } else if (status.error) {
            reject(new Error(status.error));
          } else {
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      };
      tick();
    });
  }

  els.syncBtn.addEventListener('click', triggerSync);

  // ---------------- categories ----------------
  async function loadCategories() {
    const cats = await api('/categories');
    state.categories = cats;
    renderCategories();
    if (!state.activeCategoryId && cats.length > 0) {
      selectCategory(cats[0].id);
    }
  }

  function renderCategories(filter = '') {
    els.catList.innerHTML = '';
    const q = filter.trim().toLowerCase();
    const list = state.categories.filter((c) => c.name.toLowerCase().includes(q));
    if (list.length === 0) {
      els.catList.innerHTML = `<div class="empty-hint">${
        state.categories.length === 0
          ? 'No categories yet. Connect your XC server and sync to get started.'
          : 'No categories match your filter.'
      }</div>`;
      return;
    }
    list.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'cat-item' + (c.id === state.activeCategoryId ? ' active' : '');
      item.innerHTML = `<span>${escapeHtml(c.name)}</span><span class="count">${c.channelCount}</span>`;
      item.addEventListener('click', () => selectCategory(c.id));
      els.catList.appendChild(item);
    });
  }

  els.catFilter.addEventListener('input', () => renderCategories(els.catFilter.value));

  async function selectCategory(id) {
    state.activeCategoryId = id;
    renderCategories(els.catFilter.value);
    await loadEpg(id);
  }

  // ---------------- timescale (built once, spans DAY_COUNT days) ----------------
  function renderTimescale() {
    for (let day = 0; day < DAY_COUNT; day++) {
      const dayDate = new Date(timelineStart + day * 24 * 60 * 60 * 1000);
      for (let h = 0; h < 24; h++) {
        const mark = document.createElement('div');
        mark.className = 'hour-mark' + (h === 0 ? ' day-start' : '');
        mark.style.width = (60 * PX_PER_MIN) + 'px';
        mark.style.minWidth = (60 * PX_PER_MIN) + 'px';
        const label = (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'am' : 'pm');
        mark.textContent = label;
        if (h === 0) {
          const dl = document.createElement('div');
          dl.className = 'day-label';
          dl.textContent = day === 0 ? 'Today' : dayDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
          mark.appendChild(dl);
        }
        els.epgTimescale.appendChild(mark);
      }
    }
  }

  function renderDayChips() {
    for (let day = 0; day < DAY_COUNT; day++) {
      const d = new Date(timelineStart + day * 24 * 60 * 60 * 1000);
      const chip = document.createElement('div');
      chip.className = 'day-chip' + (day === 0 ? ' active' : '');
      const dow = day === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
      const md = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      chip.innerHTML = `<span class="dow">${dow}</span>${md}`;
      chip.addEventListener('click', () => {
        els.epgBody.scrollLeft = day * DAY_WIDTH;
      });
      els.dayChips.appendChild(chip);
    }
  }

  els.epgBody.addEventListener('scroll', () => {
    const day = Math.round(els.epgBody.scrollLeft / DAY_WIDTH);
    [...els.dayChips.children].forEach((chip, i) => chip.classList.toggle('active', i === day));
  });

  els.jumpNow.addEventListener('click', () => {
    const nowOffsetMin = (Date.now() - timelineStart) / 60000;
    els.epgBody.scrollLeft = Math.max(0, nowOffsetMin * PX_PER_MIN - 300);
  });

  // ---------------- EPG rows ----------------
  async function loadEpg(categoryId) {
    els.epgRows.innerHTML = `<div class="empty-hint">Loading guide...</div>`;
    const data = await api(`/epg?category_id=${encodeURIComponent(categoryId)}&start=${timelineStart}&end=${timelineEnd}`);
    renderEpgRows(data.channels, data.programs);
    // only now does the grid actually have real (7-day-wide) content to scroll
    // within - jumping to "now" any earlier is a no-op, since the browser
    // clamps scrollLeft back to 0 on a container with nothing to scroll yet.
    requestAnimationFrame(() => els.jumpNow.click());
  }

  function renderEpgRows(channels, programsMap) {
    els.epgRows.innerHTML = '';
    document.querySelectorAll('.now-line').forEach((n) => n.remove());

    if (!channels || channels.length === 0) {
      els.epgRows.innerHTML = `<div class="empty-hint">No channels in this category yet.</div>`;
      return;
    }

    const now = Date.now();

    channels.forEach((ch) => {
      const row = document.createElement('div');
      row.className = 'epg-row';
      row.dataset.channelId = ch.id;

      const chanEl = document.createElement('div');
      chanEl.className = 'epg-channel';
      const initials = (ch.name || '?').slice(0, 2).toUpperCase();
      chanEl.innerHTML = `
        <div class="logo">${ch.logo ? `<img src="${escapeAttr(ch.logo)}" alt="" onerror="this.remove()">` : ''}${ch.logo ? '' : initials}</div>
        <div><div class="cname">${escapeHtml(ch.name)}</div><div class="cnum">CH ${ch.stream_num || ''}</div></div>
      `;
      row.appendChild(chanEl);

      const track = document.createElement('div');
      track.className = 'epg-track';
      track.style.width = (DAY_COUNT * DAY_WIDTH) + 'px';

      const progs = programsMap[ch.id] || [];
      progs.forEach((p) => {
        const startOffsetMin = (p.start - timelineStart) / 60000;
        const durMin = (p.stop - p.start) / 60000;
        const isLive = now >= p.start && now < p.stop;

        const block = document.createElement('div');
        block.className = 'epg-prog' + (isLive ? ' live' : '');
        block.style.left = (startOffsetMin * PX_PER_MIN) + 'px';
        block.style.width = Math.max(20, durMin * PX_PER_MIN - 4) + 'px';
        block.innerHTML = `${isLive ? '<span class="tag">LIVE</span>' : ''}<div class="t">${escapeHtml(p.title)}</div><div class="tm">${fmtTime(p.start)} · ${Math.round(durMin)}m</div>`;
        block.addEventListener('click', () => selectProgram(block, ch, p, isLive));
        track.appendChild(block);
      });

      row.appendChild(track);
      els.epgRows.appendChild(row);
    });

    // "now" line spanning the full height of the rendered grid
    const nowOffsetMin = (now - timelineStart) / 60000;
    if (nowOffsetMin >= 0 && nowOffsetMin <= DAY_COUNT * 24 * 60) {
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.left = (190 + nowOffsetMin * PX_PER_MIN) + 'px';
      line.style.height = (els.epgRows.scrollHeight + 44) + 'px';
      document.getElementById('epgScrollContent').appendChild(line);
    }
  }

  function selectProgram(el, channel, prog, isLive) {
    document.querySelectorAll('.epg-prog.selected').forEach((e) => e.classList.remove('selected'));
    el.classList.add('selected');
    document.querySelectorAll('.epg-channel.active').forEach((e) => e.classList.remove('active'));
    el.closest('.epg-row').querySelector('.epg-channel').classList.add('active');

    state.currentProgram = { channel, prog };

    els.synopsisPanel.innerHTML = `
      <div class="prog-meta">${isLive ? '<span class="live-tag">LIVE</span>' : ''}<span>${fmtTime(prog.start)} – ${fmtTime(prog.stop)}</span><span class="chan">on ${escapeHtml(channel.name)}</span></div>
      <div class="prog-title">${escapeHtml(prog.title)}</div>
      <div class="prog-desc">${escapeHtml(prog.description || 'No synopsis provided by your provider for this program.')}</div>
      <div class="record-control" id="recordControl">
        <button class="record-btn state-idle" id="recordBtn" disabled>Loading...</button>
      </div>
    `;
    refreshRecordButton(channel, prog);

    selectChannelForPreview(channel);
  }

  async function refreshRecordButton(channel, prog) {
    const btn = document.getElementById('recordBtn');
    if (!btn) return; // panel moved on before the fetch resolved
    let row = null;
    try {
      row = await api(`/recordings/for-program?channel_id=${encodeURIComponent(channel.id)}&start=${prog.start}&stop=${prog.stop}`);
    } catch (err) {
      console.error(err);
    }
    // bail if the user has since selected a different program
    if (!state.currentProgram || state.currentProgram.channel.id !== channel.id || state.currentProgram.prog.start !== prog.start) return;
    renderRecordButton(channel, prog, row);
  }

  function renderRecordButton(channel, prog, row) {
    const control = document.getElementById('recordControl');
    if (!control) return;

    const status = row ? row.status : null;
    let html = '';
    if (!status || status === 'cancelled') {
      html = `<button class="record-btn state-idle" id="recordBtn" data-action="record"><span class="rec-dot"></span>Record</button>`;
    } else if (status === 'scheduled') {
      html = `<button class="record-btn state-scheduled" id="recordBtn" data-action="cancel"><span class="rec-dot"></span>Cancel Recording</button>`;
    } else if (status === 'recording') {
      html = `<button class="record-btn state-recording" id="recordBtn" data-action="cancel"><span class="rec-dot"></span>Stop Recording</button>`;
    } else if (status === 'completed') {
      html = `<div class="record-status-text">✓ Recorded</div>
              <span class="record-note">Manage recordings under Settings → Recordings.</span>`;
    } else if (status === 'failed') {
      html = `<button class="record-btn state-failed" id="recordBtn" data-action="retry">⚠ Retry Recording</button>
              <span class="record-note" title="${escapeAttr(row.error || '')}">${escapeHtml((row.error || '').slice(0, 300))}</span>`;
    }
    control.innerHTML = html;

    const btn = document.getElementById('recordBtn');
    if (btn) btn.addEventListener('click', () => onRecordClick(channel, prog, row, btn.dataset.action));
  }

  async function onRecordClick(channel, prog, row, action) {
    const btn = document.getElementById('recordBtn');
    if (btn) btn.disabled = true;
    try {
      if (action === 'record' || action === 'retry') {
        const created = await api('/recordings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channelId: channel.id, channelName: channel.name,
            programTitle: prog.title, programStart: prog.start, programStop: prog.stop,
          }),
        });
        renderRecordButton(channel, prog, created);
      } else if (action === 'cancel') {
        await api(`/recordings/${row.id}`, { method: 'DELETE' });
        renderRecordButton(channel, prog, null);
      }
      refreshRecordingsBadge();
    } catch (err) {
      showError(err.message);
      if (btn) btn.disabled = false;
    }
  }

  // ---------------- recordings tab (checkbox bulk delete) ----------------
  let recordingsPollTimer = null;
  let recordingsCache = [];

  function startRecordingsPoll() {
    stopRecordingsPoll();
    recordingsPollTimer = setInterval(loadRecordingsList, 5000);
  }
  function stopRecordingsPoll() {
    clearInterval(recordingsPollTimer);
    recordingsPollTimer = null;
  }

  els.recordingsBtn.addEventListener('click', () => {
    switchSettingsTab('list');
    openSettingsModal();
  });

  function deletableStatuses() {
    return ['completed', 'failed', 'cancelled'];
  }

  async function loadRecordingsList() {
    try {
      recordingsCache = await api('/recordings');
    } catch (err) {
      console.error(err);
      return;
    }
    renderRecordingsList();
  }

  function renderRecordingsList() {
    if (recordingsCache.length === 0) {
      els.recordingsList.innerHTML = `<div class="recordings-empty">No recordings yet. Select a program in the guide and hit Record.</div>`;
      els.recSelectAll.checked = false;
      els.recSelectAll.disabled = true;
      els.recDeleteSelected.disabled = true;
      return;
    }
    els.recSelectAll.disabled = false;

    els.recordingsList.innerHTML = recordingsCache.map((r) => {
      const canSelect = deletableStatuses().includes(r.status);
      const left = canSelect
        ? `<input type="checkbox" class="rec-check" data-id="${r.id}">`
        : `<span class="rec-check-spacer"></span>`;
      const rightAction = (r.status === 'scheduled' || r.status === 'recording')
        ? `<div class="rec-actions"><button data-action="cancel" data-id="${r.id}">Cancel</button></div>`
        : '';
      return `
        <div class="rec-item">
          ${left}
          <div class="rec-info">
            <div class="rec-title">${escapeHtml(r.program_title)} <span style="color:var(--text-faint)">— ${escapeHtml(r.channel_name)}</span></div>
            <div class="rec-meta">${fmtTime(r.rec_start)} – ${fmtTime(r.rec_end)}</div>
            ${r.error ? `<div class="rec-error">${escapeHtml(r.error)}</div>` : ''}
          </div>
          <span class="rec-status ${r.status}">${r.status}</span>
          ${rightAction}
        </div>
      `;
    }).join('');

    els.recordingsList.querySelectorAll('button[data-action="cancel"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/recordings/${btn.dataset.id}`, { method: 'DELETE' });
          loadRecordingsList();
          refreshRecordingsBadge();
          if (state.currentProgram) refreshRecordButton(state.currentProgram.channel, state.currentProgram.prog);
        } catch (err) {
          showError(err.message);
        }
      });
    });

    els.recordingsList.querySelectorAll('.rec-check').forEach((cb) => {
      cb.addEventListener('change', updateDeleteSelectedState);
    });
    els.recSelectAll.checked = false;
    updateDeleteSelectedState();
  }

  function updateDeleteSelectedState() {
    const anyChecked = !!els.recordingsList.querySelector('.rec-check:checked');
    els.recDeleteSelected.disabled = !anyChecked;
  }

  els.recSelectAll.addEventListener('change', () => {
    els.recordingsList.querySelectorAll('.rec-check').forEach((cb) => { cb.checked = els.recSelectAll.checked; });
    updateDeleteSelectedState();
  });

  els.recDeleteSelected.addEventListener('click', async () => {
    const ids = [...els.recordingsList.querySelectorAll('.rec-check:checked')].map((cb) => cb.dataset.id);
    if (ids.length === 0) return;
    els.recDeleteSelected.disabled = true;
    try {
      await Promise.all(ids.map((id) => {
        const row = recordingsCache.find((r) => String(r.id) === id);
        const status = row ? row.status : '';
        return api(`/recordings/${id}?status=${status}`, { method: 'DELETE' });
      }));
      await loadRecordingsList();
      refreshRecordingsBadge();
    } catch (err) {
      showError(err.message);
    }
  });

  async function refreshRecordingsBadge() {
    try {
      const list = await api('/recordings');
      const activeCount = list.filter((r) => r.status === 'scheduled' || r.status === 'recording').length;
      els.recordingsBadge.textContent = activeCount;
      els.recordingsBadge.style.display = activeCount > 0 ? 'inline-block' : 'none';
    } catch (err) {
      console.error(err);
    }
  }

  // ---------------- video preview (click-to-play, real HLS via server proxy) ----------------
  function selectChannelForPreview(channel) {
    stopPreview();
    state.currentChannel = channel;
    els.previewLogo.textContent = (channel.name || '?').slice(0, 2).toUpperCase();
    els.previewHint.textContent = 'Click to preview stream';
  }

  function stopPreview() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    els.previewVideo.pause();
    els.previewVideo.removeAttribute('src');
    els.previewVideo.load();
    els.previewPanel.classList.remove('playing');
  }

  function startPreview() {
    if (!state.currentChannel) return;
    const src = `/api/stream/${encodeURIComponent(state.currentChannel.id)}`;
    els.previewHint.textContent = 'Connecting...';

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ maxBufferLength: 15 });
      state.hls = hls;
      hls.loadSource(src);
      hls.attachMedia(els.previewVideo);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        els.previewVideo.play().catch(() => {});
        els.previewPanel.classList.add('playing');
      });
      hls.on(window.Hls.Events.ERROR, (evt, data) => {
        if (data.fatal) {
          els.previewHint.textContent = 'Stream unavailable (' + data.details + ')';
          els.previewPanel.classList.remove('playing');
        }
      });
    } else if (els.previewVideo.canPlayType('application/vnd.apple.mpegurl')) {
      els.previewVideo.src = src;
      els.previewVideo.play().then(() => els.previewPanel.classList.add('playing')).catch(() => {});
    } else {
      els.previewHint.textContent = 'This browser cannot play HLS streams.';
    }
  }

  els.previewPanel.addEventListener('click', () => {
    if (els.previewPanel.classList.contains('playing')) {
      if (els.previewVideo.paused) els.previewVideo.play();
      else els.previewVideo.pause();
    } else {
      startPreview();
    }
  });

  // ---------------- search ----------------
  let searchDebounce = null;
  els.progSearch.addEventListener('input', () => {
    const q = els.progSearch.value.trim();
    filterVisibleEpg(q);
    clearTimeout(searchDebounce);
    if (!q) { els.searchResults.classList.remove('open'); return; }
    searchDebounce = setTimeout(() => runSearch(q), 300);
  });

  document.addEventListener('click', (e) => {
    if (!els.searchResults.contains(e.target) && e.target !== els.progSearch) {
      els.searchResults.classList.remove('open');
    }
  });

  function filterVisibleEpg(q) {
    const query = q.toLowerCase();
    document.querySelectorAll('.epg-row').forEach((row) => {
      const chanName = row.querySelector('.cname').textContent.toLowerCase();
      const progEls = row.querySelectorAll('.epg-prog');
      let anyMatch = query === '' || chanName.includes(query);
      progEls.forEach((p) => {
        const t = p.querySelector('.t').textContent.toLowerCase();
        const match = query !== '' && t.includes(query);
        p.style.outline = match ? '2px solid var(--teal)' : 'none';
        if (match) anyMatch = true;
      });
      row.style.opacity = anyMatch ? '1' : '0.25';
    });
  }

  async function runSearch(q) {
    try {
      const data = await api(`/search?q=${encodeURIComponent(q)}`);
      renderSearchResults(data, q);
    } catch (err) {
      console.error(err);
    }
  }

  function renderSearchResults(data, q) {
    const { channels, programs } = data;
    if (channels.length === 0 && programs.length === 0) {
      els.searchResults.innerHTML = `<div class="sr-empty">No matches for "${escapeHtml(q)}"</div>`;
      els.searchResults.classList.add('open');
      return;
    }
    let html = '';
    if (channels.length) {
      html += `<div class="sr-group-label">Channels</div>`;
      channels.slice(0, 6).forEach((c) => {
        html += `<div class="sr-item" data-type="channel" data-category="${escapeAttr(c.category_id)}" data-channel="${escapeAttr(c.id)}">
          <span class="t">${escapeHtml(c.name)}</span></div>`;
      });
    }
    if (programs.length) {
      html += `<div class="sr-group-label">Programs</div>`;
      programs.slice(0, 8).forEach((p) => {
        html += `<div class="sr-item" data-type="program" data-category="${escapeAttr(p.categoryId)}" data-channel="${escapeAttr(p.channelId)}" data-start="${p.start}">
          <span class="t">${escapeHtml(p.title)}</span>
          <span class="s">${escapeHtml(p.channelName)} · ${fmtTime(p.start)}</span></div>`;
      });
    }
    els.searchResults.innerHTML = html;
    els.searchResults.classList.add('open');

    els.searchResults.querySelectorAll('.sr-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const categoryId = item.dataset.category;
        const channelId = item.dataset.channel;
        els.searchResults.classList.remove('open');
        els.progSearch.value = '';
        await selectCategory(categoryId);
        // scroll to the channel row and, if a specific program, its start time
        const row = document.querySelector(`.epg-row[data-channel-id="${cssEscape(channelId)}"]`);
        if (row) {
          row.scrollIntoView({ block: 'center' });
          if (item.dataset.start) {
            const startMs = Number(item.dataset.start);
            const offsetMin = (startMs - timelineStart) / 60000;
            els.epgBody.scrollLeft = Math.max(0, offsetMin * PX_PER_MIN - 300);
            const block = [...row.querySelectorAll('.epg-prog')].find((b) => {
              const left = parseFloat(b.style.left);
              return Math.abs(left - offsetMin * PX_PER_MIN) < 2;
            });
            if (block) block.click();
          } else {
            els.epgBody.scrollLeft = 0;
          }
        }
      });
    });
  }

  // ---------------- utils ----------------
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }
  function cssEscape(str) { return String(str).replace(/["\\]/g, '\\$&'); }

  // ---------------- init ----------------
  async function init() {
    fetch('/api/version').then((r) => r.json()).then((v) => {
      document.getElementById('versionBadge').textContent = 'v' + v.version;
      document.getElementById('versionBadge').title = `Build: ${v.buildTime} · Node ${v.node}`;
      console.log(`%cDPTV Recorder v${v.version}%c - build ${v.buildTime}`, 'font-weight:bold;color:#F2A93B', 'color:inherit');
    }).catch(() => {});

    renderTimescale();
    renderDayChips();
    try {
      const s = await loadSettings();
      if (s.xcHost) {
        await loadCategories();
      }
    } catch (err) {
      console.error(err);
    }
    refreshRecordingsBadge();
    setInterval(refreshRecordingsBadge, 30000);
  }

  init();
})();
