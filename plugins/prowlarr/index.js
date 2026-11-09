import { createHash, randomUUID } from "node:crypto";

const LOG_TAG = "[prowlarr]";
const AUTH_PATH = "/api/settings/auth";
const SETTINGS_TOKEN_COOKIE = "settings-token";
const DEFAULT_PORT = 4444;

const CACHE_NAMESPACE = "ext:prowlarr";
// Prowlarr keeps releases in its own grab cache for 30 minutes, stay below that.
const SEARCH_TTL_MS = 25 * 60 * 1000;
const INDEXER_TTL_MS = 10 * 60 * 1000;
const AUTH_TTL_MS = 60 * 1000;

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 110;
const API_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_QUERY_LENGTH = 300;
const STREAM_HEARTBEAT_MS = 10_000;

const RELEASE_ID_RE = /^[0-9a-f-]{36}\.\d{1,5}$/;
const ID_LIST_RE = /^\s*\d+(\s*,\s*\d+)*\s*$/;
const PRIVACY_VALUES = ["public", "semiPrivate", "private"];

let template = "";
let apiBase = "";
let useCacheFn = null;
let signFavicon = null;

let prowlarrUrl = "";
let apiKey = "";
let categories = [];
let indexerIds = [];
let limitPerIndexer = DEFAULT_LIMIT;
let timeoutMs = DEFAULT_TIMEOUT_S * 1000;
let streamResults = true;
let localDownload = "auto";
const LOCAL_DOWNLOAD_MODES = ["auto", "magnet", "file"];

const authVerdicts = new Map();

const log = (message) => {
  console.warn(`${LOG_TAG} ${message}`);
};

const errorText = (error) => (error instanceof Error ? error.message : String(error));

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const parseIdList = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw || !ID_LIST_RE.test(raw)) return [];
  return [...new Set(raw.split(",").map((part) => Number.parseInt(part.trim(), 10)))];
};

const clampInt = (value, fallback, min, max) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const isConfiguredNow = () => Boolean(prowlarrUrl && apiKey);

const cache = () => (useCacheFn ? useCacheFn(CACHE_NAMESPACE, SEARCH_TTL_MS) : null);

// init.signal (optional) lets a caller cancel early, e.g. when the browser
// closes a streaming search; the timeout applies either way.
const fetchWithTimeout = async (url, init = {}, ms = API_TIMEOUT_MS) => {
  const timeout = AbortSignal.timeout(ms);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal });
};

// ---------------------------------------------------------------------------
// Settings-session check
// Plugin routes are public, so every route asks degoog's own
// /api/settings/auth whether the caller holds a live settings token.
// ---------------------------------------------------------------------------

const basePathOf = (reqUrl) => new URL(reqUrl).pathname.split("/api/plugin/")[0];

const selfBases = (reqUrl) => {
  const port = Number(process.env.DEGOOG_PORT) || DEFAULT_PORT;
  const basePath = basePathOf(reqUrl);
  return [`http://127.0.0.1:${port}${basePath}`, `${new URL(reqUrl).origin}${basePath}`];
};

const tokenFromCookie = (req) => {
  const raw = req.headers.get("cookie");
  if (!raw) return "";
  const match = raw
    .split(";")
    .find((part) => part.trim().startsWith(`${SETTINGS_TOKEN_COOKIE}=`));
  return match?.split("=")[1]?.trim() || "";
};

const tokenCandidates = (req) =>
  [...new Set([req.headers.get("x-settings-token") || "", tokenFromCookie(req)])].filter(Boolean);

const askAuth = async (base, cookie, token) => {
  const res = await fetchWithTimeout(`${base}${AUTH_PATH}`, {
    headers: {
      Accept: "application/json",
      ...(cookie ? { cookie } : {}),
      ...(token ? { "x-settings-token": token } : {}),
    },
  }, 5000);
  if (!res.ok) return false;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return false;
  const data = await res.json().catch(() => null);
  return data?.valid === true;
};

const rememberVerdict = (key, granted) => {
  if (!key) return;
  if (authVerdicts.size > 500) authVerdicts.clear();
  authVerdicts.set(key, { granted, until: Date.now() + AUTH_TTL_MS });
};

const checkAccess = async (req) => {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return { ok: false, status: 403, error: "Cross-site requests are not allowed." };
  }

  const tokens = tokenCandidates(req);
  for (const token of tokens) {
    const cached = authVerdicts.get(token);
    if (cached && cached.until > Date.now() && cached.granted) return { ok: true };
  }

  const cookie = req.headers.get("cookie") || "";
  const attempts = tokens.length > 0 ? tokens : [""];
  let reached = false;

  for (const base of selfBases(req.url)) {
    for (const token of attempts) {
      try {
        const granted = await askAuth(base, cookie, token);
        reached = true;
        if (granted) {
          rememberVerdict(token, true);
          return { ok: true };
        }
      } catch (error) {
        log(`settings auth check via ${base} failed: ${errorText(error)}`);
      }
    }
    if (reached) break;
  }

  if (!reached) {
    return { ok: false, status: 503, error: "Could not verify your settings session." };
  }
  return {
    ok: false,
    status: 401,
    locked: true,
    error: "Sign in to the degoog settings to use Prowlarr search.",
  };
};

const guarded = (handler) => async (req) => {
  const access = await checkAccess(req);
  if (!access.ok) return json({ error: access.error, locked: access.locked === true }, access.status);
  if (!isConfiguredNow()) {
    return json({ error: "Set the Prowlarr URL and API key in the plugin settings first." }, 503);
  }
  try {
    return await handler(req);
  } catch (error) {
    log(`route failed: ${errorText(error)}`);
    return json({ error: "Something went wrong talking to Prowlarr." }, 502);
  }
};

// ---------------------------------------------------------------------------
// Prowlarr API
// ---------------------------------------------------------------------------

const prowlarrApi = async (path, init = {}, ms = API_TIMEOUT_MS) => {
  const res = await fetchWithTimeout(`${prowlarrUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "X-Api-Key": apiKey,
      ...(init.headers || {}),
    },
  }, ms);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
};

const prowlarrErrorMessage = (result) => {
  const body = result.body;
  if (result.status === 401) return "Prowlarr rejected the API key. Check it in the plugin settings.";
  if (Array.isArray(body) && body[0]?.errorMessage) return String(body[0].errorMessage);
  if (body?.message) return String(body.message);
  return `Prowlarr answered with HTTP ${result.status}.`;
};

const normalizePrivacy = (value) => (PRIVACY_VALUES.includes(value) ? value : "unknown");

const faviconFor = (indexer) => {
  const url = Array.isArray(indexer?.indexerUrls) ? indexer.indexerUrls[0] : "";
  if (!signFavicon || !url || !/^https?:\/\//i.test(url)) return "";
  try {
    return signFavicon(url) || "";
  } catch {
    return "";
  }
};

const fieldValue = (indexer, name) =>
  (Array.isArray(indexer?.fields) ? indexer.fields : []).find((field) => field?.name === name)?.value;

const positiveNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// The per-indexer seed rules from Prowlarr (Indexer > Edit > Seed Ratio /
// Seed Time / Pack Seed Time). Prowlarr hands the same values to the download
// client when it grabs, and to Sonarr/Radarr when it syncs.
const seedRulesFor = (indexer) => {
  if (String(indexer?.protocol ?? "") !== "torrent") return null;
  const rules = {
    ratio: positiveNumber(fieldValue(indexer, "torrentBaseSettings.seedRatio")),
    timeMinutes: positiveNumber(fieldValue(indexer, "torrentBaseSettings.seedTime")),
    packTimeMinutes: positiveNumber(fieldValue(indexer, "torrentBaseSettings.packSeedTime")),
  };
  return rules.ratio || rules.timeMinutes || rules.packTimeMinutes ? rules : null;
};

// Mirrors Prowlarr's choice: the indexer's own client if it has one, else the
// enabled client for the protocol with the best (lowest) priority.
const clientNameFor = (indexer, clients) => {
  const own = clients.find((client) => client.id === indexer?.downloadClientId);
  if (own) return own.name;
  const candidates = clients.filter((client) => client.enable && client.protocol === indexer?.protocol);
  if (candidates.length === 0) return "";
  const best = Math.min(...candidates.map((client) => client.priority));
  const top = candidates.filter((client) => client.priority === best);
  return top.length === 1 ? top[0].name : "";
};

const loadDownloadClients = async () => {
  const result = await prowlarrApi("/api/v1/downloadclient").catch(() => ({ ok: false }));
  if (!result.ok || !Array.isArray(result.body)) return [];
  return result.body.map((client) => ({
    id: client.id,
    name: String(client.name ?? ""),
    enable: client.enable !== false,
    protocol: String(client.protocol ?? ""),
    priority: Number.isFinite(client.priority) ? client.priority : 1,
  }));
};

const INDEXER_CACHE_KEY = "indexers:v2";

const loadIndexers = async () => {
  const store = cache();
  const cached = store ? await store.get(INDEXER_CACHE_KEY).catch(() => null) : null;
  if (cached) return cached;

  const [result, clients] = await Promise.all([prowlarrApi("/api/v1/indexer"), loadDownloadClients()]);
  if (!result.ok || !Array.isArray(result.body)) {
    log(`indexer list failed: ${prowlarrErrorMessage(result)}`);
    return {};
  }

  const map = Object.fromEntries(
    result.body.map((indexer) => [
      String(indexer.id),
      {
        id: indexer.id,
        name: String(indexer.name ?? ""),
        privacy: normalizePrivacy(indexer.privacy),
        protocol: String(indexer.protocol ?? ""),
        favicon: faviconFor(indexer),
        enable: indexer.enable !== false,
        disabledTill: String(indexer.status?.disabledTill ?? ""),
        seed: seedRulesFor(indexer),
        preferMagnet: fieldValue(indexer, "torrentBaseSettings.preferMagnetUrl") === true,
        client: clientNameFor(indexer, clients),
      },
    ]),
  );
  if (store) await store.set(INDEXER_CACHE_KEY, map, INDEXER_TTL_MS).catch(() => {});
  return map;
};

const searchQueryString = (query, ids = indexerIds) => {
  const params = new URLSearchParams({ query, type: "search", limit: String(limitPerIndexer) });
  ids.forEach((id) => params.append("indexerIds", String(id)));
  categories.forEach((id) => params.append("categories", String(id)));
  return params.toString();
};

const searchKey = (query) =>
  createHash("sha1")
    .update(JSON.stringify([query.toLowerCase(), indexerIds, categories, limitPerIndexer, prowlarrUrl, localDownload]))
    .digest("hex");

const safeHttpUrl = (value) => {
  const raw = String(value ?? "").trim();
  return /^https?:\/\//i.test(raw) ? raw : "";
};

const categoryNames = (release) =>
  (Array.isArray(release.categories) ? release.categories : [])
    .map((category) => String(category?.name ?? ""))
    .filter(Boolean)
    .slice(0, 3);

const toNumberOrNull = (value) => (Number.isFinite(value) ? value : null);

const bySeeders = (a, b) =>
  (b.seeders ?? -1) - (a.seeders ?? -1) ||
  (b.leechers ?? -1) - (a.leechers ?? -1) ||
  (b.grabs ?? -1) - (a.grabs ?? -1);

// What the server keeps per result: the links that carry the API key.
const toInternal = (release) => ({
  guid: String(release.guid ?? ""),
  indexerId: release.indexerId,
  title: String(release.title ?? ""),
  protocol: String(release.protocol ?? ""),
  downloadUrl: safeHttpUrl(release.downloadUrl),
  magnetUrl: String(release.magnetUrl ?? "").trim(),
  infoHash: String(release.infoHash ?? "").trim(),
});

// What the "Download" button does for this release on the visitor's PC:
// open a magnet, or save the .torrent/.nzb file.
const localKindFor = (release, indexer) => {
  const hasFile = Boolean(safeHttpUrl(release.downloadUrl));
  const hasMagnet = Boolean(String(release.magnetUrl ?? "").trim() || String(release.infoHash ?? "").trim());
  if (String(release.protocol ?? "") !== "torrent") return hasFile ? "file" : null;
  const wantMagnet = localDownload === "magnet" || (localDownload === "auto" && indexer?.preferMagnet === true);
  if (wantMagnet && hasMagnet) return "magnet";
  if (hasFile) return "file";
  return hasMagnet ? "magnet" : null;
};

// What the browser gets: display fields and an opaque id, no links with keys.
const toPublic = (release, indexers, id) => {
  const indexer = indexers[String(release.indexerId)];
  return {
      id,
      title: String(release.title ?? ""),
      indexer: String(release.indexer ?? indexer?.name ?? "Unknown"),
      indexerId: release.indexerId,
      privacy: indexer?.privacy ?? "unknown",
      favicon: indexer?.favicon ?? "",
      protocol: String(release.protocol ?? ""),
      size: toNumberOrNull(release.size),
      files: toNumberOrNull(release.files),
      grabs: toNumberOrNull(release.grabs),
      seeders: toNumberOrNull(release.seeders),
      leechers: toNumberOrNull(release.leechers),
      ageMinutes: toNumberOrNull(release.ageMinutes),
      publishDate: String(release.publishDate ?? ""),
      categories: categoryNames(release),
      flags: (Array.isArray(release.indexerFlags) ? release.indexerFlags : []).map(String).slice(0, 4),
      infoUrl: safeHttpUrl(release.infoUrl) || safeHttpUrl(release.commentUrl),
      canDownload: Boolean(safeHttpUrl(release.downloadUrl)),
      canMagnet: Boolean(String(release.magnetUrl ?? "").trim() || String(release.infoHash ?? "").trim()),
      localKind: localKindFor(release, indexer),
      seed: indexer?.seed ?? null,
      client: indexer?.client ?? "",
  };
};

const normalizeReleases = (releases) =>
  releases.map((release) => ({
    ...release,
    seeders: toNumberOrNull(release.seeders),
    leechers: toNumberOrNull(release.leechers),
    grabs: toNumberOrNull(release.grabs),
  }));

const buildSearch = (releases, indexers) => {
  const searchId = randomUUID();
  return {
    searchId,
    internal: releases.map(toInternal),
    results: releases.map((release, index) => toPublic(release, indexers, `${searchId}.${index}`)),
  };
};

const searchCacheKey = (query) => `search:${searchKey(query)}`;

const readCachedSearch = async (query) => {
  const store = cache();
  if (!store) return null;
  const cached = await store.get(searchCacheKey(query)).catch(() => null);
  return cached ? { ...cached, cached: true } : null;
};

const runSearch = async (query, fresh) => {
  const store = cache();
  const key = searchCacheKey(query);
  if (!fresh) {
    const cached = await readCachedSearch(query);
    if (cached) return cached;
  }

  const started = Date.now();
  const [result, indexers] = await Promise.all([
    prowlarrApi(`/api/v1/search?${searchQueryString(query)}`, {}, timeoutMs),
    loadIndexers().catch(() => ({})),
  ]);
  if (!result.ok || !Array.isArray(result.body)) {
    return { error: prowlarrErrorMessage(result) };
  }

  const releases = normalizeReleases(result.body).sort(bySeeders);
  const { searchId, internal, results } = buildSearch(releases, indexers);
  const payload = {
    query,
    results,
    failed: [],
    tookMs: Date.now() - started,
    searchedAt: new Date().toISOString(),
  };
  if (store) {
    await store.set(`release:${searchId}`, internal, SEARCH_TTL_MS).catch(() => {});
    await store.set(key, payload, SEARCH_TTL_MS).catch(() => {});
  }
  return payload;
};

// ---------------------------------------------------------------------------
// Streaming search
// One Prowlarr request per indexer, all in parallel. Each indexer's results go
// to the browser as a server-sent event the moment that indexer answers.
// ---------------------------------------------------------------------------

const isSearchable = (indexer) => {
  if (!indexer.enable) return false;
  const disabledTill = Date.parse(indexer.disabledTill);
  if (Number.isFinite(disabledTill) && disabledTill > Date.now()) return false;
  return indexerIds.length === 0 || indexerIds.includes(indexer.id);
};

const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const indexerFailure = (error) =>
  error?.name === "TimeoutError" ? `No answer within ${Math.round(timeoutMs / 1000)}s` : errorText(error);

const replayPayload = (payload, send) => {
  const indexerCount = new Set(payload.results.map((r) => r.indexerId)).size;
  send("start", { total: indexerCount, cached: payload.cached === true });
  send("results", { results: payload.results });
  send("done", {
    total: payload.results.length,
    tookMs: payload.tookMs,
    failed: payload.failed ?? [],
    cached: payload.cached === true,
  });
};

const runStream = async (query, fresh, send, signal) => {
  if (!fresh) {
    const cached = await readCachedSearch(query);
    if (cached) {
      replayPayload(cached, send);
      return;
    }
  }

  const indexers = await loadIndexers().catch(() => ({}));
  const targets = Object.values(indexers).filter(isSearchable);
  if (targets.length === 0) {
    // No indexer list (or nothing matched it): let Prowlarr pick in one request.
    const result = await runSearch(query, true);
    if (result.error) send("error", { error: result.error });
    else replayPayload(result, send);
    return;
  }

  const store = cache();
  const started = Date.now();
  const searchId = randomUUID();
  const internal = [];
  const collected = [];
  const failed = [];
  let writes = Promise.resolve();

  // Store every batch before announcing it, so its buttons work right away.
  const persist = () => {
    if (!store) return writes;
    const snapshot = [...internal];
    writes = writes
      .then(() => store.set(`release:${searchId}`, snapshot, SEARCH_TTL_MS))
      .catch(() => {});
    return writes;
  };

  send("start", {
    total: targets.length,
    indexers: targets.map((indexer) => ({ id: indexer.id, name: indexer.name, privacy: indexer.privacy })),
  });

  const searchOne = async (indexer) => {
    const t0 = Date.now();
    try {
      const result = await prowlarrApi(
        `/api/v1/search?${searchQueryString(query, [indexer.id])}`,
        { signal },
        timeoutMs,
      );
      if (!result.ok || !Array.isArray(result.body)) throw new Error(prowlarrErrorMessage(result));
      const releases = normalizeReleases(result.body);
      const offset = internal.length;
      internal.push(...releases.map(toInternal));
      const results = releases.map((release, i) => toPublic(release, indexers, `${searchId}.${offset + i}`));
      collected.push(...results);
      await persist();
      send("results", { indexerId: indexer.id, indexer: indexer.name, results, tookMs: Date.now() - t0 });
    } catch (error) {
      if (signal.aborted) return;
      const failure = { indexerId: indexer.id, indexer: indexer.name, error: indexerFailure(error) };
      failed.push(failure);
      send("indexer-error", failure);
    }
  };

  await Promise.all(targets.map(searchOne));
  if (signal.aborted) return;

  const tookMs = Date.now() - started;
  if (store) {
    await writes;
    const payload = {
      query,
      results: [...collected].sort(bySeeders),
      failed,
      tookMs,
      searchedAt: new Date().toISOString(),
    };
    await store.set(searchCacheKey(query), payload, SEARCH_TTL_MS).catch(() => {});
  }
  send("done", { total: collected.length, tookMs, failed });
};

const streamHandler = async (req) => {
  const url = new URL(req.url);
  const query = String(url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return json({ error: "Type something to search for." }, 400);
  const fresh = url.searchParams.get("fresh") === "1";

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());

  const body = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (text) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
          abort.abort();
        }
      };
      const send = (event, data) => write(sseFrame(event, data));
      const heartbeat = setInterval(() => write(": keepalive\n\n"), STREAM_HEARTBEAT_MS);
      try {
        await runStream(query, fresh, send, abort.signal);
      } catch (error) {
        log(`stream failed: ${errorText(error)}`);
        send("error", { error: "Something went wrong talking to Prowlarr." });
      } finally {
        clearInterval(heartbeat);
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
};

// Lets script.js decide whether to show the Torrents tab. guarded() already
// did the work; reaching this handler means the visitor is signed in.
const sessionHandler = async () => json({ ok: true });

const findRelease = async (id) => {
  if (!RELEASE_ID_RE.test(String(id ?? ""))) return null;
  const [searchId, index] = String(id).split(".");
  const store = cache();
  if (!store) return null;
  const internal = await store.get(`release:${searchId}`).catch(() => null);
  return Array.isArray(internal) ? internal[Number(index)] ?? null : null;
};

// Prowlarr's download/magnet links carry the API key, so they are only ever
// followed server side. A link either redirects to a magnet or returns a file.
const resolveLink = async (url) => {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.startsWith("magnet:")) return { magnet: current };
    if (!/^https?:\/\//i.test(current)) throw new Error("unsupported link scheme");
    const res = await fetchWithTimeout(current, { redirect: "manual" }, timeoutMs);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("redirect without a location");
      current = location.startsWith("magnet:") ? location : new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`download answered HTTP ${res.status}`);
    return { response: res };
  }
  throw new Error("too many redirects");
};

const magnetFromHash = (release) =>
  `magnet:?xt=urn:btih:${encodeURIComponent(release.infoHash)}&dn=${encodeURIComponent(release.title)}`;

const safeFileName = (release, contentType) => {
  const ext = release.protocol === "usenet" || contentType.includes("nzb") ? ".nzb" : ".torrent";
  const base = release.title.replace(/[^\w.\- ()[\]]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 150);
  return `${base || "release"}${ext}`;
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const searchHandler = async (req) => {
  const url = new URL(req.url);
  const query = String(url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return json({ error: "Type something to search for." }, 400);
  const result = await runSearch(query, url.searchParams.get("fresh") === "1");
  // Upstream failures are always 502 so the client never confuses them with a
  // missing settings session (401).
  if (result.error) return json({ error: result.error }, 502);
  return json(result);
};

const readId = async (req) => {
  const body = await req.json().catch(() => null);
  return typeof body?.id === "string" ? body.id : "";
};

const expiredResponse = () =>
  json({ error: "This result has expired. Run the search again." }, 410);

const magnetHandler = async (req) => {
  const release = await findRelease(await readId(req));
  if (!release) return expiredResponse();

  const link = release.magnetUrl || release.downloadUrl;
  if (link) {
    try {
      const resolved = await resolveLink(link);
      if (resolved.magnet) return json({ magnet: resolved.magnet });
      await resolved.response.body?.cancel();
    } catch (error) {
      log(`magnet lookup failed: ${errorText(error)}`);
    }
  }
  if (release.infoHash) return json({ magnet: magnetFromHash(release) });
  return json({ error: "No magnet link available for this release." }, 404);
};

const downloadHandler = async (req) => {
  const release = await findRelease(new URL(req.url).searchParams.get("id"));
  if (!release) return expiredResponse();
  if (!release.downloadUrl) return json({ error: "No download link for this release." }, 404);

  const resolved = await resolveLink(release.downloadUrl);
  if (resolved.magnet) return json({ magnet: resolved.magnet });

  const contentType = resolved.response.headers.get("content-type") || "application/x-bittorrent";
  const fileName = safeFileName(release, contentType);
  return new Response(resolved.response.body, {
    status: 200,
    headers: {
      "Content-Type": contentType.includes("json") || contentType.includes("html")
        ? "application/octet-stream"
        : contentType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
};

const grabHandler = async (req) => {
  const release = await findRelease(await readId(req));
  if (!release) return expiredResponse();

  const result = await prowlarrApi("/api/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guid: release.guid, indexerId: release.indexerId }),
  }, timeoutMs);
  if (!result.ok) return json({ error: prowlarrErrorMessage(result) }, 502);
  return json({ ok: true, message: "Sent to your download client." });
};

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  isClientExposed: false,
  name: "Prowlarr",
  description:
    "Search all your Prowlarr indexers with !prowlarr, sorted by seeders. Only works for people signed into the degoog settings.",
  trigger: "prowlarr",
  aliases: ["prowl", "torrent", "torrents"],

  settingsSchema: [
    {
      key: "prowlarrUrl",
      label: "Prowlarr URL",
      type: "url",
      required: true,
      placeholder: "https://prowlarr.example.com",
      description: "The address degoog's server uses to reach Prowlarr, including any URL base.",
    },
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      secret: true,
      required: true,
      description: "Prowlarr > Settings > General > Security > API Key. It never leaves the degoog server.",
    },
    {
      key: "categories",
      label: "Categories",
      type: "text",
      placeholder: "2000,5000",
      description:
        "Optional comma-separated Newznab category IDs (2000 movies, 5000 TV, 3000 audio, 4000 PC). Leave empty to search everything.",
    },
    {
      key: "indexerIds",
      label: "Indexer IDs",
      type: "text",
      placeholder: "1,4,7",
      description: "Optional comma-separated Prowlarr indexer IDs. Leave empty to search every enabled indexer.",
    },
    {
      key: "streamResults",
      label: "Stream results as indexers answer",
      type: "toggle",
      default: "true",
      description:
        "On: one Prowlarr request per indexer, and each indexer's results appear as soon as it answers. Off: one combined request, and everything appears when the slowest indexer is done. If your reverse proxy buffers responses, streaming only shows results at the end.",
    },
    {
      key: "localDownload",
      label: "\"Download\" button on torrents",
      type: "select",
      options: LOCAL_DOWNLOAD_MODES,
      optionLabels: [
        "Follow each indexer's \"Prefer Magnet URL\" setting in Prowlarr",
        "Open the magnet link when there is one",
        "Save the .torrent file when there is one",
      ],
      default: "auto",
      description: "What the Download button does on the visitor's own PC. Usenet results always save the .nzb file.",
    },
    {
      key: "limit",
      label: "Results per indexer",
      type: "number",
      default: String(DEFAULT_LIMIT),
      description: "How many results Prowlarr asks each indexer for.",
    },
    {
      key: "timeoutSeconds",
      label: "Search timeout (seconds)",
      type: "number",
      default: String(DEFAULT_TIMEOUT_S),
      description: `Slow indexers can take a while. Capped at ${MAX_TIMEOUT_S} seconds.`,
    },
  ],

  routes: [
    { method: "get", path: "/session", handler: guarded(sessionHandler) },
    { method: "get", path: "/search", handler: guarded(searchHandler), rateLimit: true },
    { method: "get", path: "/stream", handler: guarded(streamHandler), rateLimit: true },
    { method: "post", path: "/magnet", handler: guarded(magnetHandler) },
    { method: "get", path: "/download", handler: guarded(downloadHandler) },
    { method: "post", path: "/grab", handler: guarded(grabHandler) },
  ],

  init(ctx) {
    template = ctx.template;
    apiBase = ctx.apiBase || "";
    useCacheFn = ctx.useCache || null;
    signFavicon = ctx.signFaviconUrl || null;
  },

  configure(settings) {
    prowlarrUrl = String(settings?.prowlarrUrl ?? "").trim().replace(/\/+$/, "");
    apiKey = String(settings?.apiKey ?? "").trim();
    categories = parseIdList(settings?.categories);
    indexerIds = parseIdList(settings?.indexerIds);
    limitPerIndexer = clampInt(settings?.limit, DEFAULT_LIMIT, 1, 1000);
    timeoutMs = clampInt(settings?.timeoutSeconds, DEFAULT_TIMEOUT_S, 5, MAX_TIMEOUT_S) * 1000;
    streamResults = String(settings?.streamResults ?? "true") !== "false";
    const mode = String(settings?.localDownload ?? "auto").trim();
    localDownload = LOCAL_DOWNLOAD_MODES.includes(mode) ? mode : "auto";
    authVerdicts.clear();
    cache()?.delete(INDEXER_CACHE_KEY).catch(() => {});
  },

  isConfigured() {
    return isConfiguredNow();
  },

  async execute(args) {
    const query = String(args ?? "").trim().slice(0, MAX_QUERY_LENGTH);
    const html = template
      .replaceAll("{{apiBase}}", esc(apiBase))
      .replaceAll("{{query}}", esc(query))
      .replaceAll("{{stream}}", streamResults ? "1" : "0");
    return { title: query ? `Prowlarr: ${query}` : "Prowlarr", html };
  },
};
