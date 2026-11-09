(() => {
  const TOKEN_KEY = "degoog-settings-token";
  const PREFS_KEY = "degoog-prowlarr-prefs";
  const PAGE_SIZE = 50;

  const PRIVACY_LABELS = {
    public: "Public",
    semiPrivate: "Semi-Private",
    private: "Private",
    unknown: "Unknown",
  };

  // Newznab top-level categories; subcategories share the thousand (2045 → 2000).
  const TOP_CATEGORIES = {
    1000: "Console",
    2000: "Movies",
    3000: "Audio",
    4000: "PC",
    5000: "TV",
    6000: "XXX",
    7000: "Books",
    8000: "Other",
  };
  const topOf = (id) => Math.floor(id / 1000) * 1000;
  const resultCategoryIds = (r) => (Array.isArray(r.categoryIds) ? r.categoryIds : []).map((c) => c.id);

  // "2000" matches anything in Movies, "2045" only Movies/UHD.
  const matchesCategory = (r, value) => {
    if (value === "all") return true;
    const wanted = Number(value);
    const ids = resultCategoryIds(r);
    return wanted % 1000 === 0 ? ids.some((id) => topOf(id) === wanted) : ids.includes(wanted);
  };

  const SORTS = {
    seeders: { label: "Seeders", compare: (a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || (b.leechers ?? -1) - (a.leechers ?? -1) },
    leechers: { label: "Leechers", compare: (a, b) => (b.leechers ?? -1) - (a.leechers ?? -1) },
    size: { label: "Size", compare: (a, b) => (b.size ?? -1) - (a.size ?? -1) },
    age: { label: "Newest", compare: (a, b) => (a.ageMinutes ?? Infinity) - (b.ageMinutes ?? Infinity) },
    grabs: { label: "Grabs", compare: (a, b) => (b.grabs ?? -1) - (a.grabs ?? -1) },
    title: { label: "Title", compare: (a, b) => a.title.localeCompare(b.title) },
  };

  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const apiBaseFromScript = () => {
    const pluginId = typeof __PLUGIN_ID__ !== "undefined" ? __PLUGIN_ID__ : "";
    return pluginId ? `/api/plugin/${encodeURIComponent(pluginId)}` : "";
  };

  const readToken = () => {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  };

  const authFetch = (url, init = {}) => {
    const token = readToken();
    return fetch(url, {
      credentials: "same-origin",
      ...init,
      headers: { ...(token ? { "x-settings-token": token } : {}), ...(init.headers || {}) },
    });
  };

  const postJson = (url, payload) =>
    authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const readJson = async (res) => {
    try {
      return await res.json();
    } catch {
      return {};
    }
  };

  const loadPrefs = () => {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      return {
        sort: SORTS[prefs.sort] ? prefs.sort : "seeders",
        hideDead: prefs.hideDead === true,
      };
    } catch {
      return { sort: "seeders", hideDead: false };
    }
  };

  const savePrefs = (prefs) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable, preferences just won't stick */
    }
  };

  const formatSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** power;
    return `${value.toFixed(power >= 3 ? 2 : value < 10 ? 1 : 0)} ${units[power]}`;
  };

  const formatAge = (minutes) => {
    if (!Number.isFinite(minutes)) return "";
    const ago = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    if (minutes < 60) return ago(Math.max(1, Math.round(minutes)), "minute");
    if (minutes < 1440) return ago(Math.round(minutes / 60), "hour");
    const days = Math.round(minutes / 1440);
    if (days < 365) return ago(days, "day");
    const years = Number((days / 365).toFixed(1));
    return `${years} year${years === 1 ? "" : "s"} ago`;
  };

  const LOCAL_ACTIONS = {
    magnet: { icon: "fa-magnet", label: "Open magnet", title: "Open the magnet link in the torrent app on this device" },
    torrent: { icon: "fa-download", label: "Download .torrent", title: "Save the .torrent file to this device" },
    nzb: { icon: "fa-download", label: "Download .nzb", title: "Save the .nzb file to this device" },
  };

  const formatDuration = (minutes) => {
    if (!Number.isFinite(minutes) || minutes <= 0) return "";
    if (minutes < 120) return `${Math.round(minutes)} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 72) return `${hours} h`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days} d ${rest} h` : `${days} d`;
  };

  // "3 d or ratio 1.0 (packs 5 d)", from the indexer's seed settings in Prowlarr.
  const seedSummary = (seed) => {
    if (!seed) return "";
    const parts = [
      seed.timeMinutes && formatDuration(seed.timeMinutes),
      seed.ratio && `ratio ${Number(seed.ratio).toFixed(seed.ratio % 1 ? 2 : 1)}`,
    ].filter(Boolean);
    const pack =
      seed.packTimeMinutes && seed.packTimeMinutes !== seed.timeMinutes
        ? ` (packs ${formatDuration(seed.packTimeMinutes)})`
        : "";
    return `${parts.join(" or ")}${pack}`;
  };

  // Shown on any indexer with seed rules in Prowlarr, and as a warning on
  // private trackers that have none, since those usually enforce hit-and-runs.
  const BADGE = "degoog-badge degoog-badge--engine-tag prowlarr-badge";

  const seedBadge = (r, privacy) => {
    if (r.protocol !== "torrent") return "";
    const summary = seedSummary(r.seed);
    if (summary) {
      return `<span class="${BADGE} prowlarr-badge--seed" data-tooltip="Seed rule for ${esc(r.indexer)} in Prowlarr. Keep seeding until one is reached."><i class="fa-solid fa-seedling"></i> Seed ${esc(summary)}</span>`;
    }
    if (privacy === "private") {
      return `<span class="${BADGE} prowlarr-badge--unset" data-tooltip="No seed ratio or time set for ${esc(r.indexer)} in Prowlarr. Check the tracker's rules to avoid a hit-and-run."><i class="fa-solid fa-seedling"></i> Seed rules not set</span>`;
    }
    return "";
  };

  const formatCount = (value) => (Number.isFinite(value) ? value.toLocaleString() : "–");

  const formatDate = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  };

  const fileNameFrom = (res, fallback) => {
    const header = res.headers.get("content-disposition") || "";
    const match = header.match(/filename="?([^";]+)"?/i);
    return match ? match[1] : fallback;
  };

  const hero = (icon, text, extra = "") => `
    <div class="prowlarr-hero">
      <i class="fa-solid ${icon} prowlarr-hero-icon"></i>
      <div class="prowlarr-hero-text">${esc(text)}</div>
      ${extra}
    </div>`;

  const initCard = (root) => {
    const apiBase = String(root.dataset.apiBase || "").trim() || apiBaseFromScript();
    const query = String(root.dataset.query || "").trim();
    const body = root.querySelector("[data-body]");
    const subtitle = root.querySelector("[data-subtitle]");
    const toolbar = root.querySelector("[data-toolbar]");
    const pager = root.querySelector("[data-pager]");
    const toast = root.querySelector("[data-toast]");
    const refreshBtn = root.querySelector("[data-refresh]");
    const status = root.querySelector("[data-status]");
    const streaming = root.dataset.stream === "1";

    const prefs = loadPrefs();
    const state = {
      results: [],
      // Streamed results that arrived after the visitor started reading.
      pending: [],
      failed: [],
      engaged: false,
      inFlight: null,
      text: "",
      privacy: "all",
      indexer: "all",
      category: "all",
      protocol: "all",
      sort: prefs.sort,
      hideDead: prefs.hideDead,
      page: 1,
    };

    let toastTimer = null;
    const showToast = (message, tone = "info") => {
      toast.textContent = message;
      toast.dataset.tone = tone;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.hidden = true;
      }, tone === "error" ? 6000 : 5000);
    };

    const setSubtitle = (text) => {
      subtitle.textContent = text;
    };

    const hideChrome = () => {
      toolbar.hidden = true;
      pager.hidden = true;
      status.hidden = true;
    };

    const visibleResults = () => {
      const needle = state.text.toLowerCase();
      return state.results
        .filter((r) => state.privacy === "all" || r.privacy === state.privacy)
        .filter((r) => state.indexer === "all" || String(r.indexerId) === state.indexer)
        .filter((r) => matchesCategory(r, state.category))
        .filter((r) => state.protocol === "all" || r.protocol === state.protocol)
        .filter((r) => !state.hideDead || r.protocol !== "torrent" || (r.seeders ?? 0) > 0)
        .filter((r) => !needle || r.title.toLowerCase().includes(needle))
        .sort(SORTS[state.sort].compare);
    };

    // Same markup and classes as a degoog web result, so the theme styles it:
    // favicon + source line, big link title, grey snippet, small tag row.
    const renderRow = (r) => {
      const privacy = PRIVACY_LABELS[r.privacy] ? r.privacy : "unknown";
      const isTorrent = r.protocol === "torrent";
      const favicon = r.favicon
        ? `<img class="result-favicon degoog-result--favicon" src="${esc(r.favicon)}" alt="" width="26" height="26" loading="lazy">`
        : `<span class="result-favicon-missing degoog-result--favicon-missing"><i class="fa-solid fa-magnet" aria-hidden="true"></i></span>`;
      const title = r.infoUrl
        ? `<a class="result-title degoog-result--title" href="${esc(r.infoUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>`
        : `<span class="result-title degoog-result--title prowlarr-title-plain">${esc(r.title)}</span>`;

      const snippet = [
        formatSize(r.size),
        formatAge(r.ageMinutes) &&
          `<span data-tooltip="${esc(formatDate(r.publishDate))}">${esc(formatAge(r.ageMinutes))}</span>`,
        r.categories.length > 0 && esc(r.categories.join(", ")),
        Number.isFinite(r.files) && r.files > 1 && `${esc(formatCount(r.files))} files`,
        !isTorrent && esc(r.protocol),
      ]
        .filter(Boolean)
        .join(" · ");

      const seedTone = (r.seeders ?? 0) === 0 ? "dead" : (r.seeders ?? 0) < 5 ? "low" : "ok";
      const peers = isTorrent
        ? `<span class="prowlarr-peers" data-tooltip="Seeders · leechers">
             <span class="prowlarr-peers-seed prowlarr-peers-seed--${seedTone}"><i class="fa-solid fa-arrow-up"></i>${esc(formatCount(r.seeders))}</span>
             <span class="prowlarr-peers-leech"><i class="fa-solid fa-arrow-down"></i>${esc(formatCount(r.leechers))}</span>
           </span>`
        : "";

      const tags = [
        seedBadge(r, privacy),
        ...r.flags.map((flag) => `<span class="${BADGE} prowlarr-badge--flag">${esc(flag)}</span>`),
        Number.isFinite(r.grabs) && `<span class="${BADGE}">${esc(formatCount(r.grabs))} grabs</span>`,
      ]
        .filter(Boolean)
        .join("");

      const seedText = seedSummary(r.seed);
      const clientName = r.client || "download client";
      const sendTip = seedText
        ? `Prowlarr sends it to ${clientName} and sets it to seed ${seedText}`
        : `Prowlarr sends it to ${clientName}`;
      const local = LOCAL_ACTIONS[r.localKind === "magnet" ? "magnet" : isTorrent ? "torrent" : "nzb"];
      const actions = [
        `<button type="button" class="degoog-btn degoog-btn--primary degoog-btn--sm prowlarr-btn" data-action="grab" data-id="${esc(r.id)}" data-tooltip="${esc(sendTip)}"><i class="fa-solid fa-paper-plane"></i><span>Send to ${esc(clientName)}</span></button>`,
        r.localKind &&
          `<button type="button" class="degoog-btn degoog-btn--sm prowlarr-btn prowlarr-btn--quiet" data-action="local" data-kind="${esc(r.localKind)}" data-id="${esc(r.id)}" data-tooltip="${esc(local.title)}"><i class="fa-solid ${local.icon}"></i><span>${esc(local.label)}</span></button>`,
      ]
        .filter(Boolean)
        .join("");

      return `
        <div class="result-item degoog-result prowlarr-result">
          <div class="result-item-inner degoog-result--inner">
            <div class="result-body degoog-result--body">
              <div class="result-url-row degoog-result--url-row">
                ${favicon}
                <cite class="result-cite degoog-result--cite">${esc(r.indexer)}</cite>
                <span class="prowlarr-privacy prowlarr-privacy--${privacy}">${esc(PRIVACY_LABELS[privacy])}</span>
                ${peers}
              </div>
              ${title}
              <p class="result-snippet degoog-result--snippet">${snippet}</p>
              ${tags ? `<div class="result-engines degoog-result--engines">${tags}</div>` : ""}
            </div>
            <div class="prowlarr-actions">${actions}</div>
          </div>
        </div>`;
    };

    // degoog's own pagination classes; clicks are handled by this card.
    const renderPager = (totalPages) => {
      if (totalPages <= 1) {
        pager.hidden = true;
        pager.innerHTML = "";
        return;
      }
      const pages = [...new Set([1, state.page - 2, state.page - 1, state.page, state.page + 1, state.page + 2, totalPages])]
        .filter((p) => p >= 1 && p <= totalPages)
        .sort((a, b) => a - b);
      const links = pages.map((p, i) => {
        const gap = i > 0 && p - pages[i - 1] > 1 ? `<span class="pagination-link prowlarr-pager-gap">…</span>` : "";
        const link =
          p === state.page
            ? `<span class="pagination-current" aria-current="page">${p}</span>`
            : `<a class="pagination-link" data-page="${p}" role="button" tabindex="0">${p}</a>`;
        return `${gap}${link}`;
      });
      pager.innerHTML = `<div class="pagination-pages">${links.join("")}</div>`;
      pager.hidden = false;
    };

    const renderList = () => {
      const visible = visibleResults();
      const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
      state.page = Math.min(state.page, totalPages);
      const slice = visible.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
      body.innerHTML =
        slice.length > 0
          ? `<div class="prowlarr-list">${slice.map(renderRow).join("")}</div>`
          : hero("fa-filter-circle-xmark", "Nothing matches these filters.");
      const count = root.querySelector("[data-count]");
      if (count) count.textContent = `${visible.length.toLocaleString()} shown`;
      renderPager(totalPages);
    };

    const option = (value, label, selected) =>
      `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;

    // Main categories with their subcategories indented below, each with how
    // many results it holds. A result counts once per entry it belongs to.
    const categoryOptions = (results) => {
      const tops = new Map();
      results.forEach((r) => {
        const ids = resultCategoryIds(r);
        const names = new Map((r.categoryIds ?? []).map((c) => [c.id, c.name]));
        new Set(ids.map(topOf)).forEach((top) => {
          if (!TOP_CATEGORIES[top]) return;
          const entry = tops.get(top) ?? { count: 0, subs: new Map() };
          ids
            .filter((id) => topOf(id) === top && id !== top)
            .forEach((id) => {
              const sub = entry.subs.get(id) ?? { name: names.get(id) ?? String(id), count: 0 };
              entry.subs.set(id, { ...sub, count: sub.count + 1 });
            });
          tops.set(top, { ...entry, count: entry.count + 1 });
        });
      });

      return [...tops.entries()]
        .sort((a, b) => a[0] - b[0])
        .flatMap(([top, entry]) => [
          { value: String(top), label: `${TOP_CATEGORIES[top]} (${entry.count})` },
          ...[...entry.subs.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([id, sub]) => ({
              value: String(id),
              label: `   ${sub.name.split("/").pop()} (${sub.count})`,
            })),
        ]);
    };

    // Dropdown options are refreshed in place as streamed batches arrive, so
    // the toolbar itself (and the focus in the filter box) never re-renders.
    const updateFilterOptions = () => {
      const all = [...state.results, ...state.pending];
      const indexers = new Map();
      all.forEach((r) => {
        const key = String(r.indexerId);
        const entry = indexers.get(key) || { name: r.indexer, count: 0 };
        indexers.set(key, { ...entry, count: entry.count + 1 });
      });
      const protocols = [...new Set(all.map((r) => r.protocol).filter(Boolean))].sort();

      const indexerSelect = toolbar.querySelector('[data-filter="indexer"]');
      if (indexerSelect) {
        indexerSelect.innerHTML = [
          option("all", `All indexers (${indexers.size})`, state.indexer),
          ...[...indexers.entries()]
            .sort((a, b) => a[1].name.localeCompare(b[1].name))
            .map(([id, entry]) => option(id, `${entry.name} (${entry.count})`, state.indexer)),
        ].join("");
      }

      const categorySelect = toolbar.querySelector('[data-filter="category"]');
      if (categorySelect) {
        const options = categoryOptions(all);
        categorySelect.innerHTML = [
          option("all", "All categories", state.category),
          ...options.map((o) => option(o.value, o.label, state.category)),
        ].join("");
        const wrap = toolbar.querySelector("[data-category-wrap]");
        if (wrap) wrap.hidden = options.length === 0;
      }

      const protocolSelect = toolbar.querySelector('[data-filter="protocol"]');
      if (protocolSelect) {
        protocolSelect.innerHTML = [
          option("all", "All protocols", state.protocol),
          ...protocols.map((p) => option(p, p, state.protocol)),
        ].join("");
        const wrap = toolbar.querySelector("[data-protocol-wrap]");
        if (wrap) wrap.hidden = protocols.length < 2;
      }
    };

    const renderToolbar = () => {
      if (!toolbar.hidden && toolbar.childElementCount > 0) {
        updateFilterOptions();
        return;
      }
      const privacyChips = ["all", "public", "semiPrivate", "private"]
        .map((value) => {
          const label = value === "all" ? "All" : PRIVACY_LABELS[value];
          const pressed = state.privacy === value;
          const dot = value === "all" ? "" : `<span class="prowlarr-dot prowlarr-dot--${value}"></span>`;
          return `<button type="button" class="prowlarr-chip" data-privacy="${value}" aria-pressed="${pressed}">${dot}${esc(label)}</button>`;
        })
        .join("");

      // Laid out like degoog's filter bar: search on top, controls below.
      toolbar.innerHTML = `
        <div class="prowlarr-filters-top">
          <div class="prowlarr-search">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" class="degoog-input" data-filter="text" placeholder="Filter titles" aria-label="Filter titles" value="${esc(state.text)}">
          </div>
          <div class="degoog-select-wrap prowlarr-select-wrap">
            <select class="degoog-input prowlarr-select" data-filter="sort" aria-label="Sort by">
              ${Object.entries(SORTS).map(([key, sort]) => option(key, sort.label, state.sort)).join("")}
            </select>
          </div>
        </div>
        <div class="prowlarr-filters-row">
          <div class="prowlarr-chips" role="group" aria-label="Indexer privacy">${privacyChips}</div>
          <div class="degoog-select-wrap prowlarr-select-wrap">
            <select class="degoog-input prowlarr-select" data-filter="indexer" aria-label="Indexer"></select>
          </div>
          <div class="degoog-select-wrap prowlarr-select-wrap" data-category-wrap hidden>
            <select class="degoog-input prowlarr-select" data-filter="category" aria-label="Category"></select>
          </div>
          <div class="degoog-select-wrap prowlarr-select-wrap" data-protocol-wrap hidden>
            <select class="degoog-input prowlarr-select" data-filter="protocol" aria-label="Protocol"></select>
          </div>
          <label class="prowlarr-check">
            <input type="checkbox" data-filter="hideDead"${state.hideDead ? " checked" : ""}>
            <span>Hide dead</span>
          </label>
          <span class="prowlarr-count" data-count></span>
        </div>`;
      toolbar.hidden = false;
      updateFilterOptions();
    };

    const renderLocked = (message) => {
      hideChrome();
      refreshBtn.hidden = true;
      setSubtitle("Settings sign-in required");
      body.innerHTML = hero(
        "fa-lock",
        message || "Sign in to the degoog settings to use Prowlarr search.",
        `<div class="prowlarr-hero-hint">Open Settings, enter the password, then run this search again.</div>`,
      );
    };

    const renderError = (message) => {
      hideChrome();
      refreshBtn.hidden = false;
      setSubtitle("Search failed");
      body.innerHTML = hero("fa-triangle-exclamation", message);
    };

    const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
    const tookText = (ms) => (Number.isFinite(ms) ? ` · ${(ms / 1000).toFixed(1)}s` : "");
    const resultCount = () => state.results.length + state.pending.length;

    const renderStatus = () => {
      const parts = [];
      if (state.pending.length > 0) {
        parts.push(
          `<button type="button" class="degoog-btn degoog-btn--sm prowlarr-new" data-merge><i class="fa-solid fa-arrow-up"></i> ${esc(plural(state.pending.length, "new result"))}, show sorted</button>`,
        );
      }
      if (state.failed.length > 0) {
        const names = state.failed
          .map((f) => `<span class="prowlarr-failed-name" data-tooltip="${esc(f.error)}">${esc(f.indexer)}</span>`)
          .join(", ");
        parts.push(
          `<span class="prowlarr-failed"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(plural(state.failed.length, "indexer"))} failed: ${names}</span>`,
        );
      }
      status.innerHTML = parts.join("");
      status.hidden = parts.length === 0;
    };

    const mergePending = () => {
      if (state.pending.length === 0) return;
      state.results = [...state.results, ...state.pending];
      state.pending = [];
      renderList();
      renderStatus();
    };

    // New results join the list straight away until the visitor starts reading
    // (scrolls, filters, clicks). After that they wait behind a "show" button
    // so rows don't jump around under the cursor.
    const addBatch = (results) => {
      if (results.length === 0) return;
      if (state.results.length === 0 || !state.engaged) {
        state.results = [...state.results, ...state.pending, ...results];
        state.pending = [];
        renderToolbar();
        renderList();
      } else {
        state.pending = [...state.pending, ...results];
        updateFilterOptions();
      }
      renderStatus();
    };

    const finish = ({ tookMs, cached }) => {
      state.inFlight = null;
      refreshBtn.hidden = false;
      const all = [...state.results, ...state.pending];
      const indexerCount = new Set(all.map((r) => r.indexerId)).size;
      setSubtitle(
        `${plural(all.length, "result")} from ${plural(indexerCount, "indexer")}${tookText(tookMs)}${cached ? " · cached" : ""}`,
      );
      if (all.length === 0) body.innerHTML = hero("fa-ghost", `No results for “${query}”.`);
      renderStatus();
    };

    const beginSearch = () => {
      state.inFlight?.abort();
      const controller = new AbortController();
      Object.assign(state, { inFlight: controller, results: [], pending: [], failed: [], engaged: false, page: 1 });
      hideChrome();
      refreshBtn.hidden = true;
      setSubtitle(`Searching for “${query}”…`);
      body.innerHTML = hero("fa-spinner fa-spin", "Asking your indexers. Slow trackers can take a while.");
      return controller;
    };

    const failFromJson = async (res) => {
      const data = await readJson(res);
      if (res.status === 401 || data.locked) renderLocked(data.error);
      else renderError(data.error || `Search failed (HTTP ${res.status}).`);
    };

    const plainSearch = async (params, signal) => {
      const res = await authFetch(`${apiBase}/search?${params}`, { signal });
      if (!res.ok) {
        await failFromJson(res);
        return;
      }
      const data = await readJson(res);
      addBatch(Array.isArray(data.results) ? data.results : []);
      finish(data);
    };

    // Minimal server-sent-events reader on top of fetch, because EventSource
    // can't send the x-settings-token header.
    const readEvents = async (res, onEvent) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        frames.forEach((frame) => {
          const lines = frame.split("\n");
          const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() || "message";
          const data = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) return;
          try {
            onEvent(event, JSON.parse(data));
          } catch {
            /* skip a malformed frame */
          }
        });
      }
    };

    const streamSearch = async (params, controller) => {
      const res = await authFetch(`${apiBase}/stream?${params}`, { signal: controller.signal });
      if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
        await failFromJson(res);
        return;
      }

      let total = 0;
      let answered = 0;
      let finished = false;
      const progress = () => {
        if (finished) return;
        setSubtitle(
          `Searching “${query}”… ${answered} of ${total} indexers answered · ${plural(resultCount(), "result")}`,
        );
      };

      await readEvents(res, (event, data) => {
        if (!root.isConnected) {
          controller.abort();
          return;
        }
        if (event === "start") {
          total = Number(data.total) || 0;
        } else if (event === "results") {
          answered = data.indexerId === undefined ? total : answered + 1;
          addBatch(Array.isArray(data.results) ? data.results : []);
        } else if (event === "indexer-error") {
          answered += 1;
          state.failed = [...state.failed, data];
          renderStatus();
        } else if (event === "done") {
          finished = true;
          finish(data);
        } else if (event === "error") {
          finished = true;
          renderError(data.error || "Search failed.");
        }
        progress();
      });

      if (finished || controller.signal.aborted) return;
      if (resultCount() > 0) {
        finish({});
        showToast("The connection dropped before every indexer answered.", "error");
      } else {
        renderError("The connection dropped before Prowlarr answered.");
      }
    };

    const search = async (fresh) => {
      if (!apiBase) {
        renderError("This plugin could not work out its own API address.");
        return;
      }
      if (!query) {
        hideChrome();
        setSubtitle("Indexer search");
        body.innerHTML = hero("fa-keyboard", "Type !prowlarr followed by what you're looking for.");
        return;
      }

      const controller = beginSearch();
      const params = new URLSearchParams({ q: query, ...(fresh ? { fresh: "1" } : {}) }).toString();
      try {
        if (streaming) await streamSearch(params, controller);
        else await plainSearch(params, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        renderError("Could not reach degoog. Check your connection and try again.");
      }
    };

    const openMagnet = async (id) => {
      const res = await postJson(`${apiBase}/magnet`, { id });
      const data = await readJson(res);
      if (!res.ok || !data.magnet) throw new Error(data.error || "No magnet link available.");
      window.location.href = data.magnet;
    };

    const saveFile = async (id) => {
      const res = await authFetch(`${apiBase}/download?id=${encodeURIComponent(id)}`);
      const type = res.headers.get("content-type") || "";
      if (type.includes("application/json")) {
        // Some indexers answer a .torrent request with a magnet redirect.
        const data = await readJson(res);
        if (res.ok && data.magnet) {
          window.location.href = data.magnet;
          return;
        }
        throw new Error(data.error || `Download failed (HTTP ${res.status}).`);
      }
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = fileNameFrom(res, "release.torrent");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    };

    const findResult = (id) => [...state.results, ...state.pending].find((r) => r.id === id);

    const runAction = async (action, id, button) => {
      const result = findResult(id);
      const seedText = seedSummary(result?.seed);
      button.disabled = true;
      try {
        if (action === "grab") {
          const res = await postJson(`${apiBase}/grab`, { id });
          const data = await readJson(res);
          if (!res.ok) throw new Error(data.error || "Prowlarr could not grab this release.");
          const client = result?.client || "your download client";
          showToast(
            seedText
              ? `Sent to ${client}. Prowlarr set it to seed ${seedText}.`
              : `Sent to ${client}.`,
            "success",
          );
          return;
        }
        if (action === "local") {
          if (button.dataset.kind === "magnet") await openMagnet(id);
          else await saveFile(id);
          if (seedText) {
            showToast(`Remember to seed: ${result.indexer} asks for ${seedText}.`, "info");
          } else if (result?.privacy === "private" && result.protocol === "torrent") {
            showToast(`${result.indexer} is private. Check its seeding rules to avoid a hit-and-run.`, "info");
          }
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't work.", "error");
      } finally {
        button.disabled = false;
      }
    };

    toolbar.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.dataset.filter !== "text") return;
      state.text = target.value;
      state.page = 1;
      renderList();
    });

    toolbar.addEventListener("change", (event) => {
      const target = event.target;
      const filter = target?.dataset?.filter;
      if (!filter || filter === "text") return;
      if (filter === "hideDead") state.hideDead = target.checked;
      else state[filter] = target.value;
      state.page = 1;
      savePrefs({ sort: state.sort, hideDead: state.hideDead });
      renderList();
    });

    toolbar.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-privacy]");
      if (!chip) return;
      state.privacy = chip.dataset.privacy;
      state.page = 1;
      toolbar.querySelectorAll("[data-privacy]").forEach((el) => {
        el.setAttribute("aria-pressed", String(el === chip));
      });
      renderList();
    });

    body.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      runAction(button.dataset.action, button.dataset.id, button);
    });

    pager.addEventListener("click", (event) => {
      const button = event.target.closest("[data-page]");
      if (!button) return;
      state.page = Number(button.dataset.page) || 1;
      renderList();
      root.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    refreshBtn.addEventListener("click", () => search(true));

    status.addEventListener("click", (event) => {
      if (event.target.closest("[data-merge]")) mergePending();
    });

    const markEngaged = () => {
      if (state.inFlight) state.engaged = true;
    };
    ["pointerdown", "keydown", "input"].forEach((type) => {
      toolbar.addEventListener(type, markEngaged);
      body.addEventListener(type, markEngaged);
      pager.addEventListener(type, markEngaged);
    });
    const onScroll = () => {
      if (!root.isConnected) {
        window.removeEventListener("scroll", onScroll);
        return;
      }
      markEngaged();
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    search(false);
  };

  // -------------------------------------------------------------------------
  // "Torrents" tab in degoog's tab bar
  // degoog's own plugin tabs are public, so this one is added here instead,
  // and only after the server confirms a settings session. It simply runs
  // !prowlarr for the current query.
  // -------------------------------------------------------------------------

  const TAB_LABEL = "Torrents";
  const OWN_TRIGGERS = /^!(?:prowlarr|prowl|torrents?)\s+|\s+!(?:prowlarr|prowl|torrents?)$/i;

  let sessionCheck = null;
  const hasSession = () => {
    sessionCheck ??= (async () => {
      const apiBase = apiBaseFromScript();
      if (!apiBase) return false;
      try {
        return (await authFetch(`${apiBase}/session`)).ok;
      } catch {
        return false;
      }
    })();
    return sessionCheck;
  };

  const activeCard = () => document.querySelector(".prowlarr-command");

  const plainQueryNow = () => {
    const fromCard = activeCard()?.dataset.query;
    if (fromCard) return fromCard;
    const current =
      window.degoog?.results?.current?.().query ?? document.getElementById("results-search-input")?.value ?? "";
    return String(current).replace(OWN_TRIGGERS, "").trim();
  };

  const runDegoogSearch = (query, type) => {
    if (typeof window.degoog?.search === "function") {
      window.degoog.search(query, type);
      return;
    }
    const params = new URLSearchParams({ q: query, ...(type && type !== "web" ? { type } : {}) });
    window.location.href = `${window.location.pathname}?${params.toString()}`;
  };

  const openTorrentsTab = () => {
    const query = plainQueryNow();
    if (!query) {
      document.getElementById("results-search-input")?.focus();
      return;
    }
    runDegoogSearch(`!prowlarr ${query}`);
  };

  // While the Prowlarr card is on screen, keep the tab bar visible (degoog
  // hides it for bang output) and mark Torrents as the active tab.
  const syncTabs = (ownTab) => {
    if (!activeCard()) {
      ownTab.classList.remove("active");
      return;
    }
    document.querySelectorAll("#results-tabs .results-tab").forEach((tab) => {
      delete tab.dataset.bangHidden;
      tab.style.display = "";
      tab.classList.toggle("active", tab === ownTab);
    });
  };

  const ensureTab = async () => {
    const tabs = document.getElementById("results-tabs");
    const tools = document.getElementById("tools-bar");
    if (!tabs || !tools) return;
    const existing = tabs.querySelector("[data-prowlarr-tab]");
    if (!existing && !(await hasSession())) return;
    const ownTab = tabs.querySelector("[data-prowlarr-tab]") ?? createTab();
    if (ownTab.nextElementSibling !== tools) tabs.insertBefore(ownTab, tools);
    syncTabs(ownTab);
  };

  const createTab = () => {
    const tab = document.createElement("div");
    tab.className = "results-tab degoog-tab prowlarr-tab";
    tab.dataset.type = "prowlarr-torrents";
    tab.dataset.prowlarrTab = "1";
    tab.setAttribute("role", "button");
    tab.tabIndex = 0;
    tab.textContent = TAB_LABEL;
    tab.addEventListener("click", openTorrentsTab);
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openTorrentsTab();
    });
    return tab;
  };

  // degoog's own tab handlers would re-run "!prowlarr …" with the new type,
  // so while the card is up, send the plain query to the clicked tab instead.
  document.addEventListener(
    "click",
    (event) => {
      const tab = event.target instanceof Element ? event.target.closest(".results-tab") : null;
      if (!tab || tab.dataset.prowlarrTab) return;
      const query = activeCard()?.dataset.query;
      const type = tab.dataset.type;
      if (!query || !type) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runDegoogSearch(query, type);
    },
    true,
  );

  const scan = () => {
    document.querySelectorAll(".prowlarr-command").forEach((root) => {
      if (root.dataset.prowlarrInit === "1") return;
      root.dataset.prowlarrInit = "1";
      initCard(root);
    });
    void ensureTab();
  };

  const start = () => {
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
