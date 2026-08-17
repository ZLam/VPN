const API_ROOT = 'https://api.themoviedb.org/3';
const TMDB_URL = 'https://www.themoviedb.org';
const POSTER_ROOT = 'https://image.tmdb.org/t/p/w92';
const DEFAULT_LANGUAGE = 'zh-CN';
const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_TIMEOUT_SECONDS = 10;
const MEDIUM_PAGE_SIZE = 3;
const LARGE_PAGE_SIZE = 5;
const MAX_POSTER_BYTES = 256 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const COLORS = {
  background: { light: '#F4F6F8', dark: '#15181C' },
  card: { light: '#FFFFFF', dark: '#22262C' },
  primary: { light: '#18202A', dark: '#F4F7FA' },
  secondary: { light: '#66717E', dark: '#A8B1BC' },
  tertiary: { light: '#8B95A1', dark: '#7F8995' },
  accent: '#01B4E4',
  warning: '#E59B28',
  error: '#E5484D',
};

class ConfigurationError extends Error {}

class TmdbRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedId(value) {
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) ? id : '';
}

function normalizedPosterPath(value) {
  const path = String(value || '').trim();
  return path.startsWith('/') && !path.includes('..') ? path : '';
}

function parseTrackedShows(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return [];

  let parsed;
  try {
    parsed = Array.isArray(rawValue) ? rawValue : JSON.parse(String(rawValue));
  } catch {
    throw new ConfigurationError('TRACKED_SHOWS 不是有效的 JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigurationError('TRACKED_SHOWS 必须是一个 JSON 数组');
  }

  const seen = new Set();
  const items = [];

  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConfigurationError(`第 ${index + 1} 项必须是对象`);
    }

    const name = String(item.name ?? '').trim();
    const displayName = String(item.displayName ?? '').trim();
    const rawId = String(item.id ?? '').trim();
    const id = normalizedId(rawId);

    if (rawId && !id) {
      throw new ConfigurationError(`第 ${index + 1} 项的 id 必须是正整数`);
    }
    if (!id && !name) {
      throw new ConfigurationError(`第 ${index + 1} 项至少需要 name 或 id`);
    }

    const key = id ? `id:${id}` : `name:${normalizedName(name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ name, id, displayName });
  });

  return items;
}

function safeGetJSON(storage, key) {
  try {
    return storage.getJSON(key);
  } catch {
    return null;
  }
}

function safeSetJSON(storage, key, value) {
  try {
    storage.setJSON(key, value);
  } catch {
    // Cache failures must not prevent live data from rendering.
  }
}

function cacheToken(value) {
  let hash = 2166136261;
  const input = String(value);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function bytesToBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;

    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 3) << 4) | (second >> 4)];
    encoded += hasSecond ? alphabet[((second & 15) << 2) | (third >> 6)] : '=';
    encoded += hasThird ? alphabet[third & 63] : '=';
  }

  return encoded;
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === 'function') {
    return response.headers.get(name) || '';
  }
  return String(response?.headers?.[name] || response?.headers?.[name.toLowerCase()] || '');
}

function posterMimeType(response) {
  const contentType = responseHeader(response, 'content-type')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return ['image/jpeg', 'image/png', 'image/webp'].includes(contentType)
    ? contentType
    : '';
}

function tmdbError(status) {
  if (status === 401) return new TmdbRequestError('TMDB Token 无效', status);
  if (status === 404) return new TmdbRequestError('找不到对应的 TMDB 剧集', status);
  if (status === 429) return new TmdbRequestError('TMDB 请求过于频繁', status);
  return new TmdbRequestError(`TMDB 请求失败（HTTP ${status}）`, status);
}

async function fetchJSON(ctx, url, token, timeoutSeconds) {
  const response = await ctx.http.get(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Egern-Episode-Tracker/1.0',
    },
    timeout: timeoutSeconds * 1000,
    credentials: 'omit',
  });

  if (response.status < 200 || response.status >= 300) {
    throw tmdbError(response.status);
  }

  return response.json();
}

async function fetchPoster(ctx, posterPath, timeoutSeconds) {
  const response = await ctx.http.get(`${POSTER_ROOT}${posterPath}`, {
    headers: {
      Accept: 'image/webp,image/png,image/jpeg',
      'User-Agent': 'Egern-Episode-Tracker/1.0',
    },
    timeout: timeoutSeconds * 1000,
    credentials: 'omit',
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`TMDB 海报请求失败（HTTP ${response.status}）`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_POSTER_BYTES) {
    throw new Error('TMDB 海报数据无效');
  }

  const mimeType = posterMimeType(response);
  if (!mimeType) throw new Error('TMDB 海报格式不受支持');
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

async function loadPoster(ctx, show, timeoutSeconds) {
  if (!show.posterPath) return '';

  const cacheKey = `episode-tracker:tmdb:poster:v1:${show.id}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);
  if (
    cached?.path === show.posterPath &&
    typeof cached?.src === 'string' &&
    cached.src.startsWith('data:image/')
  ) {
    return cached.src;
  }

  try {
    const src = await fetchPoster(ctx, show.posterPath, timeoutSeconds);
    safeSetJSON(ctx.storage, cacheKey, {
      path: show.posterPath,
      src,
      fetchedAt: Date.now(),
    });
    return src;
  } catch {
    return '';
  }
}

function chooseSearchResult(results, query) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const normalizedQuery = normalizedName(query);
  return (
    results.find(
      (result) =>
        normalizedName(result?.name) === normalizedQuery ||
        normalizedName(result?.original_name) === normalizedQuery,
    ) ||
    results[0] ||
    null
  );
}

async function resolveShowId(ctx, name, language, token, timeoutSeconds) {
  const query = normalizedName(name);
  const cacheKey = `episode-tracker:tmdb:resolved-id:v1:${cacheToken(`${language}:${query}`)}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);

  if (
    cached?.query === query &&
    cached?.language === language &&
    normalizedId(cached.id)
  ) {
    return String(cached.id);
  }

  const payload = await fetchJSON(
    ctx,
    `${API_ROOT}/search/tv?query=${encodeURIComponent(name)}&language=${encodeURIComponent(language)}&page=1&include_adult=false`,
    token,
    timeoutSeconds,
  );
  const show = chooseSearchResult(payload?.results, name);
  const id = normalizedId(show?.id);
  if (!id) throw new Error(`TMDB 中找不到“${name}”`);

  safeSetJSON(ctx.storage, cacheKey, {
    query,
    language,
    id,
    resolvedName: String(show.name || show.original_name || ''),
    resolvedAt: Date.now(),
  });
  return id;
}

function normalizeEpisode(episode) {
  if (!episode || typeof episode !== 'object') return null;
  return {
    id: normalizedId(episode.id),
    name: String(episode.name || ''),
    season: Number.isFinite(Number(episode.season_number))
      ? Number(episode.season_number)
      : null,
    number: Number.isFinite(Number(episode.episode_number))
      ? Number(episode.episode_number)
      : null,
    airdate: String(episode.air_date || ''),
  };
}

function normalizeSeason(season) {
  if (!season || typeof season !== 'object') return null;
  const number = Number(season.season_number);
  const episodeCount = Number(season.episode_count);
  return {
    number: Number.isFinite(number) && number >= 0 ? number : null,
    episodeCount:
      Number.isFinite(episodeCount) && episodeCount > 0 ? episodeCount : null,
    airdate: String(season.air_date || ''),
  };
}

function normalizeShow(payload, expectedId) {
  const id = normalizedId(payload?.id);
  const name = String(payload?.name || payload?.original_name || '').trim();
  if (!id || !name) throw new Error(`TMDB 返回的剧集 ${expectedId} 数据不完整`);

  return {
    id,
    name,
    originalName: String(payload.original_name || ''),
    status: String(payload.status || ''),
    inProduction: payload.in_production === true,
    premiered: String(payload.first_air_date || ''),
    posterPath: normalizedPosterPath(payload.poster_path),
    url: `${TMDB_URL}/tv/${id}`,
    latest: normalizeEpisode(payload.last_episode_to_air),
    next: normalizeEpisode(payload.next_episode_to_air),
    seasons: Array.isArray(payload.seasons)
      ? payload.seasons.map(normalizeSeason).filter(Boolean)
      : [],
  };
}

function isCachedShow(value, id) {
  return (
    value?.id === id &&
    Number.isFinite(Number(value.fetchedAt)) &&
    value?.show?.id === id &&
    typeof value?.show?.name === 'string' &&
    value.show.name.length > 0
  );
}

function hasPosterMetadata(value) {
  return typeof value?.show?.posterPath === 'string';
}

async function fetchShow(ctx, id, language, token, timeoutSeconds) {
  const url = `${API_ROOT}/tv/${encodeURIComponent(id)}?language=${encodeURIComponent(language)}`;
  return normalizeShow(await fetchJSON(ctx, url, token, timeoutSeconds), id);
}

async function loadShow(ctx, id, language, token, refreshMs, timeoutSeconds) {
  const languageKey = String(language).replace(/[^a-z0-9-]/gi, '_');
  const cacheKey = `episode-tracker:tmdb:show:v1:${languageKey}:${id}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);
  const now = Date.now();

  if (
    isCachedShow(cached, id) &&
    hasPosterMetadata(cached) &&
    now - Number(cached.fetchedAt) < refreshMs
  ) {
    return {
      show: cached.show,
      cacheState: 'fresh',
      nextRefreshAt: Number(cached.fetchedAt) + refreshMs,
    };
  }

  try {
    const show = await fetchShow(ctx, id, language, token, timeoutSeconds);
    const fetchedAt = Date.now();
    safeSetJSON(ctx.storage, cacheKey, { id, fetchedAt, show });
    return { show, cacheState: 'live', nextRefreshAt: fetchedAt + refreshMs };
  } catch (error) {
    if (isCachedShow(cached, id)) {
      return {
        show: cached.show,
        cacheState: 'stale',
        error,
        nextRefreshAt: Date.now() + refreshMs,
      };
    }
    throw error;
  }
}

function sourceLabel(source) {
  return source.displayName || source.name || `TMDB ID ${source.id}`;
}

async function loadTrackedShow(ctx, source, language, token, refreshMs, timeoutSeconds) {
  try {
    const id =
      source.id ||
      (await resolveShowId(ctx, source.name, language, token, timeoutSeconds));
    const loaded = await loadShow(
      ctx,
      id,
      language,
      token,
      refreshMs,
      timeoutSeconds,
    );
    return { type: 'show', source, id, ...loaded };
  } catch (error) {
    return {
      type: 'error',
      source,
      message: String(error?.message || '未知错误'),
      status: Number(error?.status) || null,
      nextRefreshAt: Date.now() + refreshMs,
    };
  }
}

async function loadEntryPosters(ctx, entries, timeoutSeconds) {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.type !== 'show') return entry;
      return {
        ...entry,
        posterSrc: await loadPoster(ctx, entry.show, timeoutSeconds),
      };
    }),
  );
}

function text(value, options = {}) {
  const node = { type: 'text', text: String(value ?? '') };
  for (const [key, option] of Object.entries(options)) {
    if (option !== undefined && option !== null) node[key] = option;
  }
  return node;
}

function stack(direction, children, options = {}) {
  const node = { type: 'stack', direction, children };
  for (const [key, option] of Object.entries(options)) {
    if (option !== undefined && option !== null) node[key] = option;
  }
  return node;
}

function spacer(length) {
  return length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
}

function padEpisodeNumber(value) {
  return String(Math.max(0, Number(value))).padStart(2, '0');
}

function episodeCode(episode) {
  if (!episode) return '';
  const hasSeason = Number.isFinite(episode.season) && episode.season > 0;
  const hasNumber = Number.isFinite(episode.number) && episode.number > 0;
  if (hasSeason && hasNumber) {
    return `S${padEpisodeNumber(episode.season)}E${padEpisodeNumber(episode.number)}`;
  }
  if (hasNumber) return `E${padEpisodeNumber(episode.number)}`;
  return '特别篇';
}

function dateParts(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function sameLocalDay(first, second) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function formatAirDate(episode, now = new Date(), unknownText = '待公布') {
  if (!episode) return '';
  const parts = dateParts(episode.airdate);
  if (!parts) return unknownText;
  const date = new Date(parts.year, parts.month - 1, parts.day);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameLocalDay(date, now)) return '今天';
  if (sameLocalDay(date, tomorrow)) return '明天';
  return `${parts.month}月${parts.day}日`;
}

function latestCompact(show) {
  if (show.latest) {
    return `${episodeCode(show.latest)} · ${formatAirDate(show.latest, new Date(), '日期未知')}`;
  }
  return hasNotPremiered(show) ? '尚未开播' : '暂无记录';
}

function currentSeason(show) {
  if (
    !show.latest ||
    !Number.isFinite(show.latest.season) ||
    !Array.isArray(show.seasons)
  ) {
    return null;
  }
  return show.seasons.find((season) => season.number === show.latest.season) || null;
}

function showHasEnded(show) {
  const status = show.status.toLowerCase();
  return status === 'ended' || status === 'canceled' || status === 'cancelled';
}

function currentSeasonHasEnded(show) {
  const season = currentSeason(show);
  if (!season) return false;
  return (
    Number.isFinite(season.episodeCount) &&
    Number.isFinite(show.latest?.number) &&
    show.latest.number >= season.episodeCount
  );
}

function hasNotPremiered(show, now = new Date()) {
  const parts = dateParts(show.premiered);
  if (!parts) return false;
  const premiere = new Date(parts.year, parts.month - 1, parts.day);
  return premiere.getTime() > now.getTime();
}

function nextStatus(show) {
  if (show.next) return `下集 ${episodeCode(show.next)} · ${formatAirDate(show.next)}`;
  if (showHasEnded(show)) return '全剧已完结';
  if (currentSeasonHasEnded(show)) return '本季已播完';
  if (
    ['returning series', 'planned', 'in production', 'pilot'].includes(
      show.status.toLowerCase(),
    )
  ) {
    return '后续待定';
  }
  return '下集未定';
}

function episodeWithName(prefix, episode, fallback) {
  if (!episode) return `${prefix} ${fallback}`;
  const name = episode.name ? ` · ${episode.name}` : '';
  const date = formatAirDate(episode, new Date(), '日期未知');
  return `${prefix} ${episodeCode(episode)}${name} · ${date}`;
}

function posterImage(src = '') {
  return {
    type: 'image',
    src: src || 'sf-symbol:photo.fill',
    ...(src ? {} : { color: COLORS.tertiary }),
    width: 30,
    height: 45,
    resizeMode: 'cover',
    borderRadius: 5,
  };
}

function showRow(entry, large) {
  if (entry.type === 'error') return errorRow(entry, large);

  const show = entry.show;
  const latest = large
    ? episodeWithName('已播', show.latest, hasNotPremiered(show) ? '尚未开播' : '暂无记录')
    : `已播 ${latestCompact(show)}`;
  const next =
    show.next && large
      ? `下集 ${episodeCode(show.next)}${show.next.name ? ` · ${show.next.name}` : ''} · ${formatAirDate(show.next)}`
      : nextStatus(show);

  const latestText = text(latest, {
    font: { size: large ? 10 : 9, weight: 'regular' },
    textColor: COLORS.secondary,
    ...(large ? { textAlign: 'left' } : {}),
    maxLines: 1,
    minScale: 0.65,
    ...(large ? {} : { flex: 1 }),
  });
  const nextText = text(next, {
    font: { size: large ? 10 : 9, weight: 'medium' },
    textColor: show.next ? COLORS.accent : COLORS.tertiary,
    textAlign: large ? 'left' : 'right',
    maxLines: 1,
    minScale: 0.62,
    ...(large ? {} : { flex: 1 }),
  });

  const titleRow = stack(
    'row',
    [
      text(entry.source.displayName || show.name || show.originalName, {
        font: { size: large ? 13 : 12, weight: 'semibold' },
        textColor: COLORS.primary,
        textAlign: large ? 'left' : undefined,
        maxLines: 1,
        minScale: 0.72,
        flex: 1,
      }),
      ...(entry.cacheState === 'stale'
        ? [
            text('缓存', {
              font: { size: 8, weight: 'semibold' },
              textColor: COLORS.warning,
              maxLines: 1,
            }),
          ]
        : []),
    ],
    { gap: 4, alignItems: 'center' },
  );

  if (large) {
    return stack(
      'row',
      [
        posterImage(entry.posterSrc),
        stack('column', [titleRow, latestText, nextText], {
          gap: 2,
          height: 45,
          alignItems: 'start',
          flex: 1,
        }),
      ],
      {
        gap: 7,
        height: 51,
        padding: [2, 8, 2, 5],
        alignItems: 'center',
        backgroundColor: COLORS.card,
        borderRadius: 8,
      },
    );
  }

  return stack(
    'column',
    [
      titleRow,
      stack('row', [latestText, nextText], {
        gap: 5,
        alignItems: 'center',
      }),
    ],
    {
      gap: 2,
      height: 31,
      padding: [0, 7],
      alignItems: 'center',
      backgroundColor: COLORS.card,
      borderRadius: 8,
    },
  );
}

function errorRow(entry, large) {
  const content = [
    text(sourceLabel(entry.source), {
      font: { size: large ? 13 : 12, weight: 'semibold' },
      textColor: COLORS.primary,
      maxLines: 1,
      minScale: 0.72,
    }),
    text(`获取失败 · ${entry.message}`, {
      font: { size: large ? 10 : 9, weight: 'regular' },
      textColor: COLORS.error,
      maxLines: 1,
      minScale: 0.62,
    }),
  ];

  if (large) {
    return stack(
      'row',
      [
        posterImage(),
        stack('column', content, {
          gap: 2,
          height: 45,
          alignItems: 'start',
          flex: 1,
        }),
      ],
      {
        gap: 7,
        height: 51,
        padding: [2, 8, 2, 5],
        alignItems: 'center',
        backgroundColor: COLORS.card,
        borderRadius: 8,
      },
    );
  }

  return stack(
    'column',
    content,
    {
      gap: 2,
      height: 31,
      padding: [0, 7],
      alignItems: 'center',
      backgroundColor: COLORS.card,
      borderRadius: 8,
    },
  );
}

function header(totalItems, page, totalPages, hasErrors) {
  return stack(
    'row',
    [
      {
        type: 'image',
        src: 'sf-symbol:play.tv.fill',
        color: COLORS.accent,
        width: 15,
        height: 15,
      },
      text(`追剧 · ${totalItems}部`, {
        font: { size: 14, weight: 'bold' },
        textColor: COLORS.primary,
        maxLines: 1,
      }),
      spacer(),
      ...(hasErrors
        ? [
            text('部分失败', {
              font: { size: 9, weight: 'semibold' },
              textColor: COLORS.error,
              maxLines: 1,
            }),
          ]
        : []),
      ...(totalPages > 1
        ? [
            text(`${page}/${totalPages}`, {
              font: { size: 10, weight: 'medium' },
              textColor: COLORS.tertiary,
              maxLines: 1,
            }),
          ]
        : []),
    ],
    { gap: 5, height: 18, alignItems: 'center' },
  );
}

function formatRefreshTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '下次刷新 待定';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `下次刷新 ${date.getMonth() + 1}月${date.getDate()}日 ${hours}:${minutes}`;
}

function footer(refreshAfter) {
  return stack(
    'row',
    [
      text('Data: TMDB', {
        font: { size: 8, weight: 'medium' },
        textColor: COLORS.tertiary,
        maxLines: 1,
      }),
      spacer(),
      text(formatRefreshTime(refreshAfter), {
        font: { size: 8, weight: 'regular' },
        textColor: COLORS.tertiary,
        maxLines: 1,
        minScale: 0.72,
      }),
    ],
    { height: 10, alignItems: 'center' },
  );
}

function nextRefreshDate(entries, refreshMs) {
  const now = Date.now();
  const candidates = entries
    .map((entry) => Number(entry.nextRefreshAt))
    .filter((value) => Number.isFinite(value) && value > 0);
  const requested = candidates.length ? Math.min(...candidates) : now + refreshMs;
  return new Date(Math.max(requested, now + 15 * MINUTE)).toISOString();
}

function listWidget(entries, options) {
  const large = options.family === 'systemLarge';
  return {
    type: 'widget',
    backgroundColor: COLORS.background,
    padding: large ? 14 : 11,
    gap: large ? 6 : 5,
    refreshAfter: options.refreshAfter,
    url: TMDB_URL,
    children: [
      header(
        options.totalItems,
        options.page,
        options.totalPages,
        entries.some((entry) => entry.type === 'error'),
      ),
      stack(
        'column',
        entries.map((entry) => showRow(entry, large)),
        { gap: large ? 4 : 3, alignItems: 'start' },
      ),
      spacer(),
      footer(options.refreshAfter),
    ],
  };
}

function stateWidget(kind, title, detail, family, refreshAfter, extra = '') {
  const large = family === 'systemLarge';
  const symbol = kind === 'error' ? 'exclamationmark.triangle.fill' : 'rectangle.stack.badge.play.fill';
  const color = kind === 'error' ? COLORS.error : COLORS.accent;
  return {
    type: 'widget',
    backgroundColor: COLORS.background,
    padding: large ? 18 : 15,
    gap: 7,
    refreshAfter,
    url: TMDB_URL,
    children: [
      spacer(),
      { type: 'image', src: `sf-symbol:${symbol}`, color, width: 28, height: 28 },
      text(title, {
        font: { size: large ? 16 : 14, weight: 'bold' },
        textColor: COLORS.primary,
        textAlign: 'center',
        maxLines: 1,
      }),
      text(detail, {
        font: { size: large ? 11 : 10, weight: 'regular' },
        textColor: COLORS.secondary,
        textAlign: 'center',
        maxLines: large ? 3 : 2,
        minScale: 0.72,
      }),
      ...(extra
        ? [
            text(extra, {
              font: { size: 9, weight: 'regular' },
              textColor: COLORS.tertiary,
              textAlign: 'center',
              maxLines: 2,
              minScale: 0.68,
            }),
          ]
        : []),
      spacer(),
      footer(refreshAfter),
    ],
  };
}

function refreshAfterInterval(refreshMs) {
  return new Date(Date.now() + refreshMs).toISOString();
}

export default async function main(ctx) {
  const family = ctx.widgetFamily || 'systemMedium';
  const language = String(ctx.env?.TMDB_LANGUAGE || DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;
  const token = String(ctx.env?.TMDB_ACCESS_TOKEN || '').trim();
  const refreshHours = positiveNumber(ctx.env?.REFRESH_HOURS, DEFAULT_REFRESH_HOURS);
  const refreshMs = refreshHours * HOUR;
  const timeoutSeconds = positiveNumber(
    ctx.env?.REQUEST_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const fallbackRefreshAfter = refreshAfterInterval(refreshMs);

  if (family !== 'systemMedium' && family !== 'systemLarge') {
    return stateWidget(
      'error',
      '不支持当前尺寸',
      '剧集追踪仅支持中号和大号 Widget。',
      family,
      fallbackRefreshAfter,
    );
  }

  let trackedShows;
  try {
    trackedShows = parseTrackedShows(ctx.env?.TRACKED_SHOWS);
  } catch (error) {
    return stateWidget(
      'error',
      '配置格式错误',
      String(error?.message || '无法读取 TRACKED_SHOWS'),
      family,
      fallbackRefreshAfter,
      '[{"name":"剧集名称","id":"TMDB TV ID","displayName":"自定义名称"}]',
    );
  }

  if (trackedShows.length === 0) {
    return stateWidget(
      'empty',
      '还没有跟踪剧集',
      '请在 TRACKED_SHOWS 中填写需要跟踪的剧集。',
      family,
      fallbackRefreshAfter,
      '[{"name":"剧集名称","id":"TMDB TV ID","displayName":"自定义名称"}]',
    );
  }

  const pageSize = family === 'systemLarge' ? LARGE_PAGE_SIZE : MEDIUM_PAGE_SIZE;
  const totalPages = Math.ceil(trackedShows.length / pageSize);
  const page = positiveInteger(ctx.env?.PAGE, 1);

  if (page > totalPages) {
    return stateWidget(
      'empty',
      '这一页没有剧集',
      `当前 PAGE=${page}，可用页码为 1–${totalPages}。`,
      family,
      fallbackRefreshAfter,
    );
  }

  if (!token) {
    return stateWidget(
      'error',
      '未配置 TMDB Token',
      '请在模块参数 TMDB_ACCESS_TOKEN 中填写 API Read Access Token。',
      family,
      fallbackRefreshAfter,
    );
  }

  const pageItems = trackedShows.slice((page - 1) * pageSize, page * pageSize);
  let entries = await Promise.all(
    pageItems.map((source) =>
      loadTrackedShow(ctx, source, language, token, refreshMs, timeoutSeconds),
    ),
  );

  if (
    entries.length > 0 &&
    entries.every((entry) => entry.type === 'error') &&
    entries.some((entry) => entry.status === 401)
  ) {
    return stateWidget(
      'error',
      'TMDB Token 无效',
      '请检查 TMDB_ACCESS_TOKEN 是否填写了完整的 API Read Access Token。',
      family,
      fallbackRefreshAfter,
    );
  }

  if (family === 'systemLarge') {
    entries = await loadEntryPosters(ctx, entries, timeoutSeconds);
  }

  return listWidget(entries, {
    family,
    page,
    totalPages,
    totalItems: trackedShows.length,
    refreshAfter: nextRefreshDate(entries, refreshMs),
  });
}
