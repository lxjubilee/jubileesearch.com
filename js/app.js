// JubileeSearch.com - Main Application JavaScript

function readSessionValue(key, fallback) {
  try { return sessionStorage.getItem(key) || fallback; } catch { return fallback; }
}

class JubileeSearch {
  constructor() {
    this.searchInput = document.getElementById('search-input');
    this.searchForm = document.getElementById('search-form');
    this.clearButton = document.getElementById('clear-button');
    this.suggestionsContainer = document.getElementById('suggestions');
    this.resultsContainer = document.getElementById('results');
    this.statsContainer = document.getElementById('stats');
    this.loadingContainer = document.getElementById('loading');

    this.debounceTimer = null;
    // Zone B collapse and the Jubilee-only filter both persist per session
    // (spec 13.5, 'User controls'). Default is both zones expanded.
    this.zoneFilter = readSessionValue('jubilee.zoneFilter', 'all');
    this.lastResponse = null;
    this.selectedSuggestionIndex = -1;
    this.suggestions = [];

    this.init();
  }

  init() {
    if (this.searchInput) {
      this.searchInput.addEventListener('input', (e) => this.handleInput(e));
      this.searchInput.addEventListener('keydown', (e) => this.handleKeydown(e));
      this.searchInput.addEventListener('focus', () => this.handleFocus());
    }

    if (this.searchForm) {
      this.searchForm.addEventListener('submit', (e) => this.handleSubmit(e));
    }

    if (this.clearButton) {
      this.clearButton.addEventListener('click', () => this.clearSearch());
    }

    // Close suggestions when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-container') && !e.target.closest('.results-search-box')) {
        this.hideSuggestions();
      }
    });

    // Check if we're on a results page with a query
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get('q');
    if (query && this.resultsContainer) {
      this.searchInput.value = query;
      this.performSearch(query);
    }

    // Update clear button visibility
    this.updateClearButton();
  }

  handleInput(e) {
    const query = e.target.value;
    this.updateClearButton();

    // Debounce suggestions
    clearTimeout(this.debounceTimer);
    if (query.length >= 1) {
      this.debounceTimer = setTimeout(() => {
        this.fetchSuggestions(query);
      }, 150);
    } else {
      this.hideSuggestions();
    }
  }

  handleKeydown(e) {
    if (!this.suggestionsContainer) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.navigateSuggestions(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.navigateSuggestions(-1);
        break;
      case 'Enter':
        if (this.selectedSuggestionIndex >= 0 && this.suggestions[this.selectedSuggestionIndex]) {
          e.preventDefault();
          this.searchInput.value = this.suggestions[this.selectedSuggestionIndex];
          this.hideSuggestions();
          this.handleSubmit(e);
        }
        break;
      case 'Escape':
        this.hideSuggestions();
        break;
    }
  }

  handleFocus() {
    if (this.searchInput.value.length >= 1) {
      this.fetchSuggestions(this.searchInput.value);
    }
  }

  handleSubmit(e) {
    e.preventDefault();
    const query = this.searchInput.value.trim();
    if (query.length >= 2) {
      this.hideSuggestions();

      // Check if we're on the home page or results page
      if (this.resultsContainer) {
        // Update URL without reload
        const newUrl = `${window.location.pathname}?q=${encodeURIComponent(query)}`;
        window.history.pushState({ query }, '', newUrl);
        this.performSearch(query);
      } else {
        // Navigate to results page
        window.location.href = `/search?q=${encodeURIComponent(query)}`;
      }
    }
  }

  async fetchSuggestions(query) {
    try {
      const response = await fetch(`/api/v1/suggest?q=${encodeURIComponent(query)}`);
      const data = await response.json();

      this.suggestions = data.suggestions || [];
      this.renderSuggestions();
    } catch (error) {
      console.error('Error fetching suggestions:', error);
      this.suggestions = [];
      this.hideSuggestions();
    }
  }

  renderSuggestions() {
    if (!this.suggestionsContainer || this.suggestions.length === 0) {
      this.hideSuggestions();
      return;
    }

    this.suggestionsContainer.innerHTML = this.suggestions.map((suggestion, index) => `
      <div class="suggestion-item ${index === this.selectedSuggestionIndex ? 'selected' : ''}"
           data-index="${index}">
        <span class="suggestion-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
        </span>
        <span class="suggestion-text">${this.escapeHtml(suggestion)}</span>
      </div>
    `).join('');

    // Add click handlers
    this.suggestionsContainer.querySelectorAll('.suggestion-item').forEach((item) => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        this.searchInput.value = this.suggestions[index];
        this.hideSuggestions();
        this.handleSubmit(new Event('submit'));
      });
    });

    this.suggestionsContainer.classList.add('visible');
  }

  navigateSuggestions(direction) {
    if (!this.suggestionsContainer || this.suggestions.length === 0) return;

    this.selectedSuggestionIndex += direction;

    if (this.selectedSuggestionIndex < -1) {
      this.selectedSuggestionIndex = this.suggestions.length - 1;
    } else if (this.selectedSuggestionIndex >= this.suggestions.length) {
      this.selectedSuggestionIndex = -1;
    }

    this.renderSuggestions();

    // Update input with selected suggestion
    if (this.selectedSuggestionIndex >= 0) {
      this.searchInput.value = this.suggestions[this.selectedSuggestionIndex];
    }
  }

  hideSuggestions() {
    if (this.suggestionsContainer) {
      this.suggestionsContainer.classList.remove('visible');
      this.suggestionsContainer.innerHTML = '';
    }
    this.selectedSuggestionIndex = -1;
  }

  // -------------------------------------------------------------------------
  // Two-zone results (R1, spec 13.5).
  //
  // Zone A is "From Jubilee" and Zone B is "From the wider web". Zone A is
  // always rendered first and Zone B always beneath it, at every viewport --
  // acceptance criterion 12. That ordering is not a CSS decision that a media
  // query could undo: the two blocks are appended in order, and Zone B is not
  // reachable above Zone A by any responsive rule.
  //
  // No result card contains an image at any tier (P10, acceptance criterion 15).
  // The favicons the previous version fetched are gone: they were images in a
  // result card, and they also announced the reader to every domain in the
  // result list. A text initial does the same job and tells nobody.
  // -------------------------------------------------------------------------

  async performSearch(query) {
    if (!this.resultsContainer) return;

    this.showLoading();

    try {
      const params = new URLSearchParams({ q: query });
      if (this.zoneFilter === 'jubilee') params.set('zones', 'A');
      const session = this.sessionId();
      if (session) params.set('session', session);

      const response = await fetch(`/api/v1/search?${params}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `search returned ${response.status}`);
      }
      const data = await response.json();

      this.hideLoading();
      this.lastResponse = data;
      this.renderResponse(data);
    } catch (error) {
      console.error('Search error:', error);
      this.hideLoading();
      this.renderError();
    }
  }

  renderResponse(data) {
    const zoneA = data.zone_a;
    const zoneB = data.zone_b;
    const total = (zoneA?.results?.length || 0) + (zoneB?.results?.length || 0);

    if (this.statsContainer) {
      const seconds = ((data.took_ms || 0) / 1000).toFixed(2);
      const cached = data.cache_hit ? ' · cached' : '';
      this.statsContainer.textContent = total === 0
        ? `No results (${seconds} seconds)${cached}`
        : `${total} result${total === 1 ? '' : 's'} (${seconds} seconds)${cached}`;
    }

    const blocks = [];

    if (data.scripture_card) blocks.push(this.renderScriptureCard(data.scripture_card));
    if (data.navigational) blocks.push(this.renderNavigational(data.navigational));
    if (data.entity_panel) blocks.push(this.renderEntityPanel(data.entity_panel));
    if (data.best_bets && data.best_bets.length) blocks.push(this.renderBestBets(data.best_bets));

    blocks.push(this.renderFilterChips());
    if (zoneA) blocks.push(this.renderZoneA(zoneA));
    if (zoneB) blocks.push(this.renderZoneB(zoneB));

    if (total === 0 && !data.scripture_card && !(data.best_bets || []).length) {
      blocks.push(this.renderNoResultsBlock(data.query));
    }

    this.resultsContainer.innerHTML = blocks.join('');
    this.bindResultHandlers(data.query_id);
  }

  renderFilterChips() {
    const chip = (value, label) => `
      <button type="button" class="zone-chip${this.zoneFilter === value ? ' is-active' : ''}"
              data-zone-filter="${value}" aria-pressed="${this.zoneFilter === value}">
        ${label}
      </button>`;
    return `<div class="zone-chips" role="group" aria-label="Result scope">
      ${chip('all', 'All results')}${chip('jubilee', 'Jubilee only')}
    </div>`;
  }

  renderZoneA(zone) {
    if (!zone.results.length) {
      // The honest empty state (spec 13.5). Padding the block with weak matches
      // is the failure this replaces, and every one of these is logged as a
      // content gap for the writing team.
      return `
        <section class="zone zone-a zone-a-empty" aria-labelledby="zone-a-heading">
          <h2 id="zone-a-heading" class="zone-heading">${this.escapeHtml(zone.label)}</h2>
          <p class="zone-empty-copy">
            The Jubilee network has not covered this one yet.
            <a href="/suggest?q=${encodeURIComponent(this.searchInput?.value || '')}" class="zone-empty-link">
              Tell us what you were looking for
            </a> and we will pass it to the writing team.
          </p>
        </section>`;
    }

    return `
      <section class="zone zone-a" aria-labelledby="zone-a-heading" data-coverage="${zone.coverage}">
        <h2 id="zone-a-heading" class="zone-heading">${this.escapeHtml(zone.label)}</h2>
        <div class="zone-results">
          ${zone.results.map((r) => this.renderResultItem(r, 'A')).join('')}
        </div>
      </section>`;
  }

  renderZoneB(zone) {
    const collapsed = this.zoneBCollapsed();
    return `
      <section class="zone zone-b${collapsed ? ' is-collapsed' : ''}" aria-labelledby="zone-b-heading">
        <div class="zone-heading-row">
          <h2 id="zone-b-heading" class="zone-heading">${this.escapeHtml(zone.label)}</h2>
          <button type="button" class="zone-toggle" data-zone-toggle
                  aria-expanded="${!collapsed}" aria-controls="zone-b-results">
            ${collapsed ? 'Show' : 'Hide'}
          </button>
        </div>
        <p class="zone-note">
          These come from outside the Jubilee network and are not Jubilee-endorsed.
        </p>
        <div class="zone-results" id="zone-b-results"${collapsed ? ' hidden' : ''}>
          ${zone.results.length
            ? zone.results.map((r) => this.renderResultItem(r, 'B')).join('')
            : '<p class="zone-empty-copy">Nothing from the wider web cleared the safety gates for this search.</p>'}
        </div>
      </section>`;
  }

  renderResultItem(result, zone) {
    const host = this.getHostname(result.url);
    const initial = host.charAt(0).toUpperCase();
    const tierLabel = zone === 'B' && result.tier
      ? `<span class="result-tier" title="${result.tier === 'T2' ? 'Approved faith-based site' : 'Open web, safety screened'}">${result.tier === 'T2' ? 'Approved' : 'Open web'}</span>`
      : '';

    // Thread continuation (R10, spec 13.9). T1 only, up to three.
    const thread = (result.thread || []).length
      ? `<nav class="result-thread" aria-label="Continue this thread">
           <span class="result-thread-label">Continue this thread</span>
           ${result.thread.map((t) => `
             <a href="${this.escapeHtml(t.url)}" class="result-thread-link">${this.escapeHtml(t.title || t.url)}</a>`).join('')}
         </nav>`
      : '';

    return `
      <article class="result-item" data-page-id="${result.page_id}" data-zone="${zone}" data-position="${result.position}">
        <div class="result-title-row">
          <div class="result-favicon-placeholder" aria-hidden="true">${this.escapeHtml(initial)}</div>
          <a href="${this.escapeHtml(result.url)}" class="result-title" data-result-link
             target="_blank" rel="noopener">${this.escapeHtml(result.title || result.url)}</a>
        </div>
        <div class="result-url-line">
          <span class="result-site-name-link">${this.escapeHtml(result.site_name || host)}</span>
          <span class="result-url-separator">›</span>
          <span class="result-url-link">${this.escapeHtml(this.truncateUrl(result.url))}</span>
          ${tierLabel}
        </div>
        <p class="result-snippet">${this.snippetHtml(result.snippet)}</p>
        ${thread}
        <button type="button" class="result-report" data-report-url="${this.escapeHtml(result.url)}">Report this result</button>
      </article>`;
  }

  // ts_headline wraps its matches in <mark>. That is the one tag allowed
  // through; everything else in the snippet is escaped, because the text came
  // out of a crawled page.
  snippetHtml(snippet) {
    return this.escapeHtml(snippet || '')
      .replace(/&lt;mark&gt;/g, '<mark>')
      .replace(/&lt;\/mark&gt;/g, '</mark>');
  }

  renderBestBets(bets) {
    return `
      <section class="best-bets" aria-label="Editor picks">
        ${bets.map((b) => `
          <article class="best-bet">
            <a href="${this.escapeHtml(b.url)}" class="best-bet-title" target="_blank" rel="noopener">${this.escapeHtml(b.title)}</a>
            ${b.blurb ? `<p class="best-bet-blurb">${this.escapeHtml(b.blurb)}</p>` : ''}
          </article>`).join('')}
      </section>`;
  }

  // Quoted verbatim from the JSV, never paraphrased and never commented on
  // (spec 13.2, principle P7). If the passage could not be resolved the API
  // sends no card at all, so there is no "not found" state to render here.
  renderScriptureCard(card) {
    return `
      <section class="scripture-card" aria-label="Scripture passage">
        <h2 class="scripture-reference">${this.escapeHtml(card.reference)}</h2>
        <div class="scripture-text">
          ${card.verses.map((v) => `
            <p class="scripture-verse"><sup>${v.verse}</sup> ${this.escapeHtml(v.text)}</p>`).join('')}
        </div>
        <p class="scripture-citation">${this.escapeHtml(card.citation)}${
          card.chapter_url ? ` · <a href="${this.escapeHtml(card.chapter_url)}">Read the full chapter</a>` : ''}</p>
      </section>`;
  }

  renderEntityPanel(entity) {
    const facts = Array.isArray(entity.facts) ? entity.facts : [];
    return `
      <aside class="entity-panel" aria-label="${this.escapeHtml(entity.name)}">
        <h2 class="entity-name">${this.escapeHtml(entity.name)}</h2>
        ${entity.summary ? `<p class="entity-summary">${this.escapeHtml(entity.summary)}</p>` : ''}
        ${facts.length ? `<dl class="entity-facts">${facts.map((f) => `
          <dt>${this.escapeHtml(f.label)}</dt><dd>${this.escapeHtml(f.value)}</dd>`).join('')}</dl>` : ''}
        <p class="entity-source">
          From <a href="${this.escapeHtml(entity.source_url)}">${this.escapeHtml(entity.source_name)}</a>
        </p>
      </aside>`;
  }

  renderNavigational(nav) {
    return `
      <section class="navigational" aria-label="Site match">
        <a href="${this.escapeHtml(nav.url)}" class="navigational-title">${this.escapeHtml(nav.title)}</a>
        <span class="navigational-host">${this.escapeHtml(nav.host)}</span>
        ${nav.deep_links.length ? `<nav class="navigational-links">${nav.deep_links.map((l) => `
          <a href="${this.escapeHtml(l.url)}">${this.escapeHtml(l.title || l.url)}</a>`).join('')}</nav>` : ''}
      </section>`;
  }

  renderNoResultsBlock(query) {
    return `
      <div class="no-results">
        <p>Nothing matched <strong>${this.escapeHtml(query)}</strong>.</p>
        <p>Try different words, or fewer of them.</p>
      </div>`;
  }

  bindResultHandlers(queryId) {
    // Click logging (R7). Sent with keepalive so navigating away does not
    // cancel it -- an unlogged click is a click the ranking never learns from.
    for (const link of this.resultsContainer.querySelectorAll('[data-result-link]')) {
      link.addEventListener('click', () => {
        const card = link.closest('.result-item');
        if (!queryId || !card) return;
        fetch('/api/v1/event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            query_id: queryId,
            page_id: Number(card.dataset.pageId),
            zone: card.dataset.zone,
            position: Number(card.dataset.position),
            type: 'click',
          }),
        }).catch(() => {});
      });
    }

    for (const button of this.resultsContainer.querySelectorAll('[data-report-url]')) {
      button.addEventListener('click', () => this.reportResult(button));
    }

    const toggle = this.resultsContainer.querySelector('[data-zone-toggle]');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const collapsed = !this.zoneBCollapsed();
        try { sessionStorage.setItem('jubilee.zoneB.collapsed', String(collapsed)); } catch {}
        this.renderResponse(this.lastResponse);
      });
    }

    for (const chip of this.resultsContainer.querySelectorAll('[data-zone-filter]')) {
      chip.addEventListener('click', () => {
        this.zoneFilter = chip.dataset.zoneFilter;
        try { sessionStorage.setItem('jubilee.zoneFilter', this.zoneFilter); } catch {}
        this.performSearch(this.searchInput.value.trim());
      });
    }
  }

  async reportResult(button) {
    const reason = window.prompt('What is wrong with this result? A short reason is enough.');
    if (!reason) return;
    button.disabled = true;
    try {
      await fetch('/api/v1/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: button.dataset.reportUrl, reason }),
      });
      button.textContent = 'Reported — thank you';
    } catch {
      button.textContent = 'Could not send the report';
      button.disabled = false;
    }
  }

  zoneBCollapsed() {
    // "a Zone B collapse toggle whose state persists per session" (spec 13.5).
    // Session storage, not local: the preference is about this visit.
    try { return sessionStorage.getItem('jubilee.zoneB.collapsed') === 'true'; } catch { return false; }
  }

  sessionId() {
    try {
      let id = sessionStorage.getItem('jubilee.session');
      if (!id) {
        id = (crypto.randomUUID?.() ?? String(Date.now() + Math.random())).slice(0, 36);
        sessionStorage.setItem('jubilee.session', id);
      }
      return id;
    } catch { return null; }
  }

  getHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  truncateUrl(url) {
    return url.length > 60 ? `${url.substring(0, 57)}...` : url;
  }

  renderNoResults(query) {
    if (this.statsContainer) {
      this.statsContainer.innerHTML = '';
    }

    this.resultsContainer.innerHTML = `
      <div class="no-results">
        <h2>No results found for "${this.escapeHtml(query)}"</h2>
        <p>Try different keywords or check your spelling.</p>
        <p>You can also try searching for Bible verses, topics, or phrases.</p>
      </div>
    `;
  }

  renderError() {
    if (this.statsContainer) {
      this.statsContainer.innerHTML = '';
    }

    this.resultsContainer.innerHTML = `
      <div class="no-results">
        <h2>Something went wrong</h2>
        <p>We couldn't complete your search. Please try again.</p>
      </div>
    `;
  }

  showLoading() {
    if (this.loadingContainer) {
      this.loadingContainer.style.display = 'flex';
    }
    if (this.resultsContainer) {
      this.resultsContainer.style.display = 'none';
    }
  }

  hideLoading() {
    if (this.loadingContainer) {
      this.loadingContainer.style.display = 'none';
    }
    if (this.resultsContainer) {
      this.resultsContainer.style.display = 'block';
    }
  }

  clearSearch() {
    this.searchInput.value = '';
    this.searchInput.focus();
    this.updateClearButton();
    this.hideSuggestions();
  }

  updateClearButton() {
    if (this.clearButton) {
      if (this.searchInput.value.length > 0) {
        this.clearButton.classList.add('visible');
      } else {
        this.clearButton.classList.remove('visible');
      }
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.jubileeSearch = new JubileeSearch();

  // Initialize location detection for results page
  if (document.getElementById('user-location')) {
    initLocationDetection();
  }
});

// Location detection for footer
function initLocationDetection() {
  const locationElement = document.getElementById('user-location');
  const updateButton = document.getElementById('update-location');

  // Check if we have a cached location
  const cachedLocation = localStorage.getItem('userLocation');
  if (cachedLocation) {
    locationElement.textContent = cachedLocation;
  }

  // Try to get user's location
  detectLocation();

  // Update location button handler
  if (updateButton) {
    updateButton.addEventListener('click', (e) => {
      e.preventDefault();
      locationElement.textContent = 'Updating location...';
      detectLocation(true);
    });
  }
}

function detectLocation(forceRefresh = false) {
  const locationElement = document.getElementById('user-location');

  if (!navigator.geolocation) {
    locationElement.textContent = 'Location not available';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        const locationName = await reverseGeocode(latitude, longitude);
        locationElement.textContent = locationName;
        localStorage.setItem('userLocation', locationName);
      } catch (error) {
        console.error('Geocoding error:', error);
        locationElement.textContent = 'Location unavailable';
      }
    },
    (error) => {
      console.error('Geolocation error:', error);
      switch (error.code) {
        case error.PERMISSION_DENIED:
          locationElement.textContent = 'Location access denied';
          break;
        case error.POSITION_UNAVAILABLE:
          locationElement.textContent = 'Location unavailable';
          break;
        case error.TIMEOUT:
          locationElement.textContent = 'Location request timed out';
          break;
        default:
          locationElement.textContent = 'Location unavailable';
      }
    },
    {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: forceRefresh ? 0 : 600000 // Cache for 10 minutes unless forcing refresh
    }
  );
}

async function reverseGeocode(latitude, longitude) {
  // Using OpenStreetMap's Nominatim API (free, no API key required)
  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14&addressdetails=1`,
    {
      headers: {
        'Accept-Language': 'en-US,en',
        'User-Agent': 'JubileeSearch/1.0'
      }
    }
  );

  if (!response.ok) {
    throw new Error('Geocoding request failed');
  }

  const data = await response.json();

  // Build a readable location string
  const address = data.address || {};
  const parts = [];

  // Try to get neighborhood or suburb first, then city
  if (address.neighbourhood) {
    parts.push(address.neighbourhood);
  } else if (address.suburb) {
    parts.push(address.suburb);
  } else if (address.village) {
    parts.push(address.village);
  } else if (address.town) {
    parts.push(address.town);
  }

  // Add city if different from above
  if (address.city && !parts.includes(address.city)) {
    parts.push(address.city);
  }

  // Add state abbreviation
  if (address.state) {
    parts.push(address.state);
  }

  if (parts.length === 0) {
    // Fallback to display name
    return data.display_name?.split(',').slice(0, 3).join(',') || 'Unknown location';
  }

  return parts.join(', ');
}
