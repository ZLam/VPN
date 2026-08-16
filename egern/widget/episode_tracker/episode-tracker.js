const API_ROOT = 'https://api.tvmaze.com';
const TVMAZE_URL = 'https://www.tvmaze.com';
const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_TIMEOUT_SECONDS = 10;
const MEDIUM_PAGE_SIZE = 3;
const LARGE_PAGE_SIZE = 7;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const COLORS = {
  background: { light: '#F4F6F8', dark: '#15181C' },
  card: { light: '#FFFFFF', dark: '#22262C' },
  primary: { light: '#18202A', dark: '#F4F7FA' },
  secondary: { light: '#66717E', dark: '#A8B1BC' },
  tertiary: { light: '#8B95A1', dark: '#7F8995' },
  accent: '#06A77D',
  warning: '#E59B28',
  error: '#E5484D',
};

class ConfigurationError extends Error {}

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
    items.push({ name, id });
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

async function fetchJSON(ctx, url, timeoutSeconds) {
  const response = await ctx.http.get(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Egern-Episode-Tracker/1.0',
    },
    timeout: timeoutSeconds * 1000,
    credentials: 'omit',
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`TVmaze 请求失败（HTTP ${response.status}）`);
  }

  return response.json();
}

function chooseSearchResult(results, query) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const normalizedQuery = normalizedName(query);
  return (
    results.find((result) => normalizedName(result?.show?.name) === normalizedQuery)?.show ||
    results[0]?.show ||
    null
  );
}

async function resolveShowId(ctx, name, timeoutSeconds) {
  const query = normalizedName(name);
  const cacheKey = `episode-tracker:resolved-id:v1:${cacheToken(query)}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);

  if (cached?.query === query && normalizedId(cached.id)) return String(cached.id);

  const results = await fetchJSON(
    ctx,
    `${API_ROOT}/search/shows?q=${encodeURIComponent(name)}`,
    timeoutSeconds,
  );
  const show = chooseSearchResult(results, name);
  const id = normalizedId(show?.id);
  if (!id) throw new Error(`TVmaze 中找不到“${name}”`);

  safeSetJSON(ctx.storage, cacheKey, {
    query,
    id,
    resolvedName: String(show.name || ''),
    resolvedAt: Date.now(),
  });
  return id;
}

function normalizeEpisode(episode) {
  if (!episode || typeof episode !== 'object') return null;
  return {
    id: normalizedId(episode.id),
    name: String(episode.name || ''),
    season: Number.isFinite(Number(episode.season)) ? Number(episode.season) : null,
    number: Number.isFinite(Number(episode.number)) ? Number(episode.number) : null,
    type: String(episode.type || ''),
    airdate: String(episode.airdate || ''),
    airtime: String(episode.airtime || ''),
    airstamp: String(episode.airstamp || ''),
    url: String(episode.url || ''),
  };
}

function normalizeShow(payload, expectedId) {
  const id = normalizedId(payload?.id);
  const name = String(payload?.name || '').trim();
  if (!id || !name) throw new Error(`TVmaze 返回的剧集 ${expectedId} 数据不完整`);

  return {
    id,
    name,
    status: String(payload.status || ''),
    premiered: String(payload.premiered || ''),
    ended: String(payload.ended || ''),
    url: String(payload.url || `${TVMAZE_URL}/shows/${id}`),
    latest: normalizeEpisode(payload?._embedded?.previousepisode),
    next: normalizeEpisode(payload?._embedded?.nextepisode),
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

async function fetchShow(ctx, id, timeoutSeconds) {
  const url = `${API_ROOT}/shows/${encodeURIComponent(id)}?embed%5B%5D=previousepisode&embed%5B%5D=nextepisode`;
  return normalizeShow(await fetchJSON(ctx, url, timeoutSeconds), id);
}

async function loadShow(ctx, id, refreshMs, timeoutSeconds) {
  const cacheKey = `episode-tracker:show:v1:${id}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);
  const now = Date.now();

  if (isCachedShow(cached, id) && now - Number(cached.fetchedAt) < refreshMs) {
    return {
      show: cached.show,
      cacheState: 'fresh',
      nextRefreshAt: Number(cached.fetchedAt) + refreshMs,
    };
  }

  try {
    const show = await fetchShow(ctx, id, timeoutSeconds);
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
  return source.name || `TVmaze ID ${source.id}`;
}

async function loadTrackedShow(ctx, source, refreshMs, timeoutSeconds) {
  try {
    const id = source.id || (await resolveShowId(ctx, source.name, timeoutSeconds));
    const loaded = await loadShow(ctx, id, refreshMs, timeoutSeconds);
    return { type: 'show', source, id, ...loaded };
  } catch (error) {
    return {
      type: 'error',
      source,
      message: String(error?.message || '未知错误'),
      nextRefreshAt: Date.now() + refreshMs,
    };
  }
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

function clockText(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatAirTime(episode, now = new Date()) {
  if (!episode) return '';

  if (episode.airstamp) {
    const date = new Date(episode.airstamp);
    if (!Number.isNaN(date.getTime())) {
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      if (sameLocalDay(date, now)) return `今天 ${clockText(date)}`;
      if (sameLocalDay(date, tomorrow)) return `明天 ${clockText(date)}`;
      return `${date.getMonth() + 1}月${date.getDate()}日 ${clockText(date)}`;
    }
  }

  const parts = dateParts(episode.airdate);
  if (!parts) return '待公布';
  const dateLabel = `${parts.month}月${parts.day}日`;
  return episode.airtime ? `${dateLabel} ${episode.airtime}` : dateLabel;
}

function latestCompact(show) {
  if (show.latest) return episodeCode(show.latest);
  return hasNotPremiered(show) ? '尚未开播' : '暂无记录';
}

function hasNotPremiered(show, now = new Date()) {
  const parts = dateParts(show.premiered);
  if (!parts) return false;
  const premiere = new Date(parts.year, parts.month - 1, parts.day);
  return premiere.getTime() > now.getTime();
}

function nextCompact(show) {
  if (show.next) return `${episodeCode(show.next)} · ${formatAirTime(show.next)}`;
  return show.status.toLowerCase() === 'ended' ? '已完结' : '待定';
}

function episodeWithName(prefix, episode, fallback) {
  if (!episode) return `${prefix} ${fallback}`;
  const name = episode.name ? ` · ${episode.name}` : '';
  return `${prefix} ${episodeCode(episode)}${name}`;
}

function showRow(entry, large) {
  if (entry.type === 'error') return errorRow(entry, large);

  const show = entry.show;
  const latest = large
    ? episodeWithName('已播', show.latest, hasNotPremiered(show) ? '尚未开播' : '暂无记录')
    : `已播 ${latestCompact(show)}`;
  const next = show.next
    ? large
      ? `下集 ${episodeCode(show.next)}${show.next.name ? ` · ${show.next.name}` : ''} · ${formatAirTime(show.next)}`
      : `下集 ${nextCompact(show)}`
    : `下集 ${nextCompact(show)}`;

  return stack(
    'column',
    [
      stack(
        'row',
        [
          text(show.name, {
            font: { size: large ? 13 : 12, weight: 'semibold' },
            textColor: COLORS.primary,
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
      ),
      stack(
        'row',
        [
          text(latest, {
            font: { size: large ? 10 : 9, weight: 'regular' },
            textColor: COLORS.secondary,
            maxLines: 1,
            minScale: 0.65,
            flex: 1,
          }),
          text(next, {
            font: { size: large ? 10 : 9, weight: 'medium' },
            textColor: show.next ? COLORS.accent : COLORS.tertiary,
            textAlign: 'right',
            maxLines: 1,
            minScale: 0.62,
            flex: 1,
          }),
        ],
        { gap: large ? 8 : 5, alignItems: 'center' },
      ),
    ],
    {
      gap: 2,
      height: large ? 34 : 31,
      padding: large ? [0, 8] : [0, 7],
      backgroundColor: COLORS.card,
      borderRadius: 8,
    },
  );
}

function errorRow(entry, large) {
  return stack(
    'column',
    [
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
    ],
    {
      gap: 2,
      height: large ? 34 : 31,
      padding: large ? [0, 8] : [0, 7],
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

function footer() {
  return stack(
    'row',
    [
      text('Data: TVmaze', {
        font: { size: 8, weight: 'medium' },
        textColor: COLORS.tertiary,
        maxLines: 1,
      }),
      spacer(),
      text('每日更新', {
        font: { size: 8, weight: 'regular' },
        textColor: COLORS.tertiary,
        maxLines: 1,
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
    url: TVMAZE_URL,
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
      footer(),
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
    url: TVMAZE_URL,
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
      footer(),
    ],
  };
}

function refreshAfterInterval(refreshMs) {
  return new Date(Date.now() + refreshMs).toISOString();
}

export default async function main(ctx) {
  const family = ctx.widgetFamily || 'systemMedium';
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
      '[{"name":"剧集名称","id":"TVmaze ID"}]',
    );
  }

  if (trackedShows.length === 0) {
    return stateWidget(
      'empty',
      '还没有跟踪剧集',
      '请在 TRACKED_SHOWS 中填写需要跟踪的剧集。',
      family,
      fallbackRefreshAfter,
      '[{"name":"剧集名称","id":"TVmaze ID"}]',
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

  const pageItems = trackedShows.slice((page - 1) * pageSize, page * pageSize);
  const entries = await Promise.all(
    pageItems.map((source) => loadTrackedShow(ctx, source, refreshMs, timeoutSeconds)),
  );

  return listWidget(entries, {
    family,
    page,
    totalPages,
    totalItems: trackedShows.length,
    refreshAfter: nextRefreshDate(entries, refreshMs),
  });
}
