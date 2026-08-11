const COLLECTIONS = {
  show_global_best_weekly: {
    fallbackName: '豆瓣国外综艺榜',
    shortName: '国外综艺',
    symbol: 'tv',
    accent: '#F59E0B',
  },
  tv_global_best_weekly: {
    fallbackName: '豆瓣全球剧集榜',
    shortName: '全球剧集',
    symbol: 'play.tv.fill',
    accent: '#7C83FD',
  },
  movie_weekly_best: {
    fallbackName: '豆瓣一周口碑电影榜',
    shortName: '口碑电影',
    symbol: 'film.fill',
    accent: '#30A46C',
  },
};

const API_ROOT = 'https://m.douban.com/rexxar/api/v2/subject_collection';
const DETAIL_API_ROOT = 'https://m.douban.com/rexxar/api/v2';
const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_TIMEOUT_SECONDS = 10;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const COLORS = {
  background: { light: '#F3F5F4', dark: '#151816' },
  card: { light: '#FFFFFF', dark: '#222624' },
  cardMuted: { light: '#E7EBE8', dark: '#2A2F2C' },
  primary: { light: '#17201B', dark: '#F4F7F5' },
  secondary: { light: '#647069', dark: '#A8B1AC' },
  tertiary: { light: '#89938E', dark: '#7E8983' },
  score: '#F59E0B',
  up: '#30A46C',
  down: '#E5484D',
};

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function selectedCollection(env) {
  const id = env?.COLLECTION_ID || 'show_global_best_weekly';
  if (!COLLECTIONS[id]) {
    throw new Error(`Unsupported COLLECTION_ID: ${id}`);
  }
  return { id, ...COLLECTIONS[id] };
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
    // A full cache must never prevent the widget from rendering live data.
  }
}

function normalizePayload(payload, collection, fetchedAt) {
  const rawItems = payload?.subject_collection_items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('Douban returned an empty ranking');
  }

  const metadata = payload.subject_collection || {};
  const items = rawItems.slice(0, 10).map((item, index) => {
    const rating = Number(item?.rating?.value);
    const ratingCount = Number(item?.rating?.count);
    const trendValue = Number(item?.rank_value_changed);

    return {
      id: String(item?.id || ''),
      rank: Number(item?.rank) || index + 1,
      title: String(item?.title || '未命名条目'),
      subtype: String(item?.subtype || item?.type || 'tv'),
      rating: Number.isFinite(rating) && rating > 0 ? rating : null,
      ratingCount: Number.isFinite(ratingCount) && ratingCount > 0 ? ratingCount : 0,
      subtitle: String(item?.card_subtitle || ''),
      description: String(item?.description || item?.abstract || item?.intro || ''),
      tags: Array.isArray(item?.tags)
        ? item.tags.map((tag) => String(tag?.name || '')).filter(Boolean).slice(0, 3)
        : [],
      cover: String(item?.cover_url || item?.pic?.large || item?.pic?.normal || ''),
      photos: Array.isArray(item?.photos) ? item.photos.filter(Boolean).slice(0, 4) : [],
      trend: item?.trend_up ? 'up' : item?.trend_down ? 'down' : 'equal',
      trendValue: Number.isFinite(trendValue) && trendValue > 0 ? trendValue : 0,
      webUrl: String(item?.url || ''),
      appUri: String(item?.uri || ''),
      link: String(item?.sharing_url || item?.url || item?.uri || ''),
    };
  });

  return {
    collectionId: collection.id,
    name: String(metadata.name || metadata.title || collection.fallbackName),
    shortName: collection.shortName,
    description: String(metadata.description || ''),
    updatedAt: String(metadata.updated_at || ''),
    fetchedAt,
    total: Number(payload.total) || items.length,
    listUrl: `https://m.douban.com/subject_collection/${collection.id}`,
    items,
  };
}

async function fetchRanking(ctx, collection, timeoutSeconds) {
  const url = `${API_ROOT}/${collection.id}/items?playable=0&start=0&count=10`;
  const response = await ctx.http.get(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: `https://m.douban.com/subject_collection/${collection.id}`,
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    },
    timeout: timeoutSeconds * 1000,
    credentials: 'omit',
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Douban request failed with HTTP ${response.status}`);
  }

  return normalizePayload(await response.json(), collection, Date.now());
}

async function loadRanking(ctx, collection, refreshMs, timeoutSeconds) {
  const cacheKey = `douban-ranking:data:${collection.id}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);

  if (
    cached?.collectionId === collection.id &&
    Array.isArray(cached.items) &&
    cached.items.length > 0 &&
    Date.now() - Number(cached.fetchedAt || 0) < refreshMs
  ) {
    return { ranking: cached, cacheState: 'fresh' };
  }

  try {
    const ranking = await fetchRanking(ctx, collection, timeoutSeconds);
    safeSetJSON(ctx.storage, cacheKey, ranking);
    return { ranking, cacheState: 'live' };
  } catch (error) {
    if (cached?.collectionId === collection.id && Array.isArray(cached.items) && cached.items.length > 0) {
      return { ranking: cached, cacheState: 'stale', error };
    }
    throw error;
  }
}

function bytesToBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const triple = (first << 16) | (second << 8) | third;

    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += hasSecond ? alphabet[(triple >> 6) & 63] : '=';
    output += hasThird ? alphabet[triple & 63] : '=';
  }

  return output;
}

function normalizedMimeType(response, url) {
  const header = response?.headers?.get?.('content-type');
  if (header?.startsWith('image/')) return header.split(';')[0];
  if (/\.png(?:$|\?)/i.test(url)) return 'image/png';
  if (/\.webp(?:$|\?)/i.test(url)) return 'image/webp';
  return 'image/jpeg';
}

async function loadHeroPoster(ctx, ranking, collection, timeoutSeconds) {
  const url = ranking.items[0]?.cover;
  if (!url) return null;

  const cacheKey = `douban-ranking:poster:${collection.id}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);
  if (cached?.url === url && typeof cached.dataUri === 'string') return cached.dataUri;

  try {
    const response = await ctx.http.get(url, {
      headers: {
        Referer: ranking.items[0]?.webUrl || ranking.listUrl,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      },
      timeout: timeoutSeconds * 1000,
      credentials: 'omit',
    });
    if (response.status < 200 || response.status >= 300) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 1_500_000) return null;

    const dataUri = `data:${normalizedMimeType(response, url)};base64,${bytesToBase64(bytes)}`;
    safeSetJSON(ctx.storage, cacheKey, { url, dataUri, fetchedAt: Date.now() });
    return dataUri;
  } catch {
    return null;
  }
}

async function loadHeroDescription(ctx, ranking, refreshMs, timeoutSeconds) {
  const first = ranking.items[0];
  if (!first?.id || first.description) return first?.description || '';

  const cacheKey = `douban-ranking:description:${first.id}`;
  const cached = safeGetJSON(ctx.storage, cacheKey);
  if (
    cached?.id === first.id &&
    typeof cached.description === 'string' &&
    cached.description &&
    Date.now() - Number(cached.fetchedAt || 0) < refreshMs
  ) {
    return cached.description;
  }

  const subtype = first.subtype === 'movie' ? 'movie' : 'tv';

  try {
    const response = await ctx.http.get(`${DETAIL_API_ROOT}/${subtype}/${encodeURIComponent(first.id)}`, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: `https://m.douban.com/${subtype}/${encodeURIComponent(first.id)}/`,
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      },
      timeout: timeoutSeconds * 1000,
      credentials: 'omit',
    });
    if (response.status < 200 || response.status >= 300) return cached?.description || '';

    const payload = await response.json();
    const description = String(payload?.intro || payload?.description || payload?.abstract || '').trim();
    if (description) {
      safeSetJSON(ctx.storage, cacheKey, { id: first.id, description, fetchedAt: Date.now() });
    }
    return description || cached?.description || '';
  } catch {
    return cached?.description || '';
  }
}

function scoreText(item) {
  return item.rating === null ? '暂无评分' : item.rating.toFixed(1);
}

function trendText(item) {
  if (item.trend === 'up') return `↑${item.trendValue || ''}`;
  if (item.trend === 'down') return `↓${item.trendValue || ''}`;
  return '—';
}

function trendColor(item) {
  if (item.trend === 'up') return COLORS.up;
  if (item.trend === 'down') return COLORS.down;
  return COLORS.tertiary;
}

function compactDate(value) {
  const match = String(value || '').match(/^\d{4}-(\d{2})-(\d{2})/);
  return match ? `${Number(match[1])}/${Number(match[2])}` : '';
}

function abbreviatedCount(value) {
  if (value >= 10000) return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`;
  return value > 0 ? String(value) : '';
}

function text(textValue, options = {}) {
  const node = { type: 'text', text: String(textValue ?? '') };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null) node[key] = value;
  }
  return node;
}

function stack(direction, children, options = {}) {
  const node = { type: 'stack', direction, children };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null) node[key] = value;
  }
  return node;
}

function spacer(length) {
  return length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
}

function posterNode(dataUri, collection, width, height) {
  if (!dataUri) {
    return {
      type: 'image',
      src: `sf-symbol:${collection.symbol}`,
      color: collection.accent,
      width,
      height,
      resizeMode: 'contain',
      borderRadius: 9,
    };
  }

  return {
    type: 'image',
    src: dataUri,
    width,
    height,
    resizeMode: 'cover',
    borderRadius: 9,
  };
}

function header(ranking, collection, cacheState, compact = false) {
  const rightLabel = cacheState === 'stale' ? '缓存' : compactDate(ranking.updatedAt);
  return stack(
    'row',
    [
      {
        type: 'image',
        src: `sf-symbol:${collection.symbol}`,
        color: collection.accent,
        width: compact ? 13 : 15,
        height: compact ? 13 : 15,
      },
      text(compact ? collection.shortName : ranking.name, {
        font: { size: compact ? 12 : 14, weight: 'bold' },
        textColor: COLORS.primary,
        maxLines: 1,
        minScale: 0.72,
      }),
      spacer(),
      text(rightLabel, {
        font: { size: compact ? 9 : 10, weight: 'medium' },
        textColor: cacheState === 'stale' ? COLORS.down : COLORS.tertiary,
        maxLines: 1,
      }),
    ],
    {
      gap: 5,
      height: compact ? 15 : 18,
      alignItems: 'center',
    },
  );
}

function rankRow(item, accent, options = {}) {
  return stack(
    'row',
    [
      text(item.rank, {
        font: { size: options.fontSize || 11, weight: 'bold' },
        textColor: item.rank <= 3 ? accent : COLORS.secondary,
        textAlign: 'center',
      }),
      text(item.title, {
        font: { size: options.fontSize || 11, weight: item.rank <= 3 ? 'semibold' : 'regular' },
        textColor: COLORS.primary,
        maxLines: 1,
        minScale: 0.72,
        flex: 1,
      }),
      text(scoreText(item), {
        font: { size: options.fontSize || 11, weight: 'semibold' },
        textColor: COLORS.score,
        maxLines: 1,
      }),
      text(trendText(item), {
        font: { size: Math.max((options.fontSize || 11) - 1, 8), weight: 'medium' },
        textColor: trendColor(item),
        textAlign: 'right',
        maxLines: 1,
      }),
    ],
    {
      gap: 4,
      alignItems: 'center',
      padding: options.padding || [2, 0],
      backgroundColor: options.backgroundColor,
      borderRadius: options.borderRadius,
    },
  );
}

function smallRankRow(item, accent) {
  return stack(
    'row',
    [
      text(item.rank, {
        font: { size: 10, weight: 'bold' },
        textColor: accent,
        maxLines: 1,
      }),
      text(item.title, {
        font: { size: 10, weight: 'semibold' },
        textColor: COLORS.primary,
        maxLines: 1,
        minScale: 0.65,
      }),
      spacer(),
      text(scoreText(item), {
        font: { size: 10, weight: 'semibold' },
        textColor: COLORS.score,
        maxLines: 1,
      }),
      text(trendText(item), {
        font: { size: 9, weight: 'medium' },
        textColor: trendColor(item),
        maxLines: 1,
      }),
    ],
    {
      gap: 3,
      height: 15,
      alignItems: 'center',
    },
  );
}

function smallWidget(ranking, collection, cacheState, poster, refreshAfter) {
  const [first, second, third] = ranking.items;

  return {
    type: 'widget',
    backgroundColor: COLORS.background,
    padding: 12,
    gap: 4,
    refreshAfter,
    url: ranking.listUrl,
    children: [
      header(ranking, collection, cacheState, true),
      stack(
        'row',
        [
          posterNode(poster, collection, 40, 58),
          stack(
            'column',
            [
              stack(
                'row',
                [
                  text(first.rank, {
                    font: { size: 12, weight: 'bold' },
                    textColor: collection.accent,
                    textAlign: 'center',
                  }),
                  text(first.title, {
                    font: { size: 12, weight: 'bold' },
                    textColor: COLORS.primary,
                    maxLines: 2,
                    minScale: 0.68,
                    flex: 1,
                  }),
                ],
                { gap: 4, alignItems: 'start' },
              ),
              spacer(),
              stack(
                'row',
                [
                  text(`★ ${scoreText(first)}`, {
                    font: { size: 11, weight: 'semibold' },
                    textColor: COLORS.score,
                    maxLines: 1,
                  }),
                  spacer(),
                  text(trendText(first), {
                    font: { size: 9, weight: 'medium' },
                    textColor: trendColor(first),
                    maxLines: 1,
                  }),
                ],
                { gap: 3, alignItems: 'center' },
              ),
            ],
            { gap: 2, height: 58, alignItems: 'start', flex: 1 },
          ),
        ],
        { gap: 7, height: 58, alignItems: 'start' },
      ),
      stack(
        'column',
        [
          second ? smallRankRow(second, collection.accent) : spacer(0),
          third ? smallRankRow(third, collection.accent) : spacer(0),
        ],
        { gap: 3, height: 33, alignItems: 'start' },
      ),
    ],
  };
}

function mediumWidget(ranking, collection, cacheState, poster, refreshAfter) {
  return {
    type: 'widget',
    backgroundColor: COLORS.background,
    padding: 13,
    gap: 8,
    refreshAfter,
    url: ranking.listUrl,
    children: [
      header(ranking, collection, cacheState),
      stack(
        'row',
        [
          posterNode(poster, collection, 62, 88),
          stack(
            'column',
            ranking.items.slice(0, 5).map((item) =>
              rankRow(item, collection.accent, {
                fontSize: 11,
                padding: [3, 5],
                backgroundColor: item.rank === 1 ? COLORS.card : undefined,
                borderRadius: item.rank === 1 ? 7 : undefined,
              }),
            ),
            { gap: 2, alignItems: 'start', flex: 1 },
          ),
        ],
        { gap: 9, alignItems: 'start' },
      ),
    ],
  };
}

function largeWidget(ranking, collection, cacheState, poster, refreshAfter) {
  const first = ranking.items[0];
  const count = abbreviatedCount(first.ratingCount);
  const titleMaxLines = Array.from(first.title).length > 13 ? 2 : 1;
  const descriptionMaxLines = Math.max(2, 4 - (titleMaxLines - 1) - (first.tags.length ? 1 : 0));

  return {
    type: 'widget',
    backgroundColor: COLORS.background,
    padding: 15,
    gap: 9,
    refreshAfter,
    url: ranking.listUrl,
    children: [
      header(ranking, collection, cacheState),
      stack(
        'row',
        [
          posterNode(poster, collection, 64, 91),
          stack(
            'column',
            [
              stack(
                'row',
                [
                  text(first.rank, {
                    font: { size: 16, weight: 'bold' },
                    textColor: collection.accent,
                    textAlign: 'center',
                  }),
                  text(first.title, {
                    font: { size: 16, weight: 'bold' },
                    textColor: COLORS.primary,
                    maxLines: titleMaxLines,
                    minScale: 0.75,
                    flex: 1,
                  }),
                ],
                { gap: 4, height: titleMaxLines === 2 ? 38 : 20, alignItems: 'start' },
              ),
              text(`★ ${scoreText(first)}${count ? `  ·  ${count}人评分` : ''}`, {
                font: { size: 12, weight: 'semibold' },
                textColor: COLORS.score,
                maxLines: 1,
              }),
              ...(first.tags.length
                ? [
                    text(first.tags.join('  ·  '), {
                      font: { size: 9, weight: 'medium' },
                      textColor: collection.accent,
                      maxLines: 1,
                      minScale: 0.7,
                    }),
                  ]
                : []),
              first.subtitle
                ? text(first.subtitle, {
                    font: { size: 10, weight: 'regular' },
                    textColor: COLORS.secondary,
                    maxLines: 2,
                    minScale: 0.75,
                  })
                : spacer(0),
              first.description
                ? text(first.description, {
                    font: { size: 10, weight: 'regular' },
                    textColor: COLORS.secondary,
                    maxLines: descriptionMaxLines,
                    minScale: 0.75,
                  })
                : spacer(),
            ],
            { gap: 3, alignItems: 'start', flex: 1 },
          ),
        ],
        {
          gap: 10,
          alignItems: 'start',
          padding: 9,
          backgroundColor: COLORS.card,
          borderRadius: 11,
        },
      ),
      stack(
        'column',
        ranking.items.slice(1, 8).map((item) =>
          rankRow(item, collection.accent, {
            fontSize: 11,
            padding: [4, 6],
            backgroundColor: COLORS.cardMuted,
            borderRadius: 7,
          }),
        ),
        { gap: 3, alignItems: 'start' },
      ),
    ],
  };
}

function accessoryRectangularWidget(ranking, collection, cacheState, refreshAfter) {
  return {
    type: 'widget',
    padding: 2,
    gap: 2,
    refreshAfter,
    url: ranking.listUrl,
    children: [
      header(ranking, collection, cacheState, true),
      ...ranking.items.slice(0, 2).map((item) => rankRow(item, collection.accent, { fontSize: 10 })),
    ],
  };
}

function accessoryCircularWidget(ranking, collection, refreshAfter) {
  const first = ranking.items[0];
  return {
    type: 'widget',
    padding: 2,
    gap: 0,
    refreshAfter,
    url: ranking.listUrl,
    children: [
      text(collection.id.startsWith('show_') ? '综' : collection.id.startsWith('movie_') ? '影' : '剧', {
        font: { size: 10, weight: 'bold' },
        textColor: collection.accent,
        textAlign: 'center',
        maxLines: 1,
      }),
      text(scoreText(first), {
        font: { size: 17, weight: 'bold' },
        textColor: COLORS.primary,
        textAlign: 'center',
        maxLines: 1,
        minScale: 0.7,
      }),
    ],
  };
}

function accessoryInlineWidget(ranking, collection, refreshAfter) {
  const first = ranking.items[0];
  return {
    type: 'widget',
    refreshAfter,
    url: ranking.listUrl,
    children: [
      text(`${collection.shortName} · 1 ${first.title} ${scoreText(first)}`, {
        font: { size: 12, weight: 'medium' },
        maxLines: 1,
        minScale: 0.72,
      }),
    ],
  };
}

function errorWidget(collection, message, refreshAfter) {
  return {
    type: 'widget',
    backgroundColor: COLORS.background,
    padding: 16,
    gap: 8,
    refreshAfter,
    url: `https://m.douban.com/subject_collection/${collection.id}`,
    children: [
      {
        type: 'image',
        src: 'sf-symbol:exclamationmark.triangle.fill',
        color: COLORS.score,
        width: 24,
        height: 24,
      },
      text(collection.fallbackName, {
        font: { size: 14, weight: 'bold' },
        textColor: COLORS.primary,
        maxLines: 1,
      }),
      text('暂时无法更新，点击打开豆瓣榜单。', {
        font: { size: 11, weight: 'regular' },
        textColor: COLORS.secondary,
        maxLines: 2,
      }),
      text(String(message || '网络请求失败'), {
        font: { size: 9, weight: 'regular' },
        textColor: COLORS.tertiary,
        maxLines: 2,
        minScale: 0.7,
      }),
    ],
  };
}

function refreshDate(ranking, refreshMs) {
  const fetchedAt = Number(ranking?.fetchedAt || Date.now());
  const requested = fetchedAt + refreshMs;
  return new Date(Math.max(requested, Date.now() + 15 * MINUTE)).toISOString();
}

function renderWidget(family, ranking, collection, cacheState, poster, refreshAfter) {
  if (family === 'accessoryInline') return accessoryInlineWidget(ranking, collection, refreshAfter);
  if (family === 'accessoryCircular') return accessoryCircularWidget(ranking, collection, refreshAfter);
  if (family === 'accessoryRectangular') {
    return accessoryRectangularWidget(ranking, collection, cacheState, refreshAfter);
  }
  if (family === 'systemSmall') {
    return smallWidget(ranking, collection, cacheState, poster, refreshAfter);
  }
  if (family === 'systemLarge' || family === 'systemExtraLarge') {
    return largeWidget(ranking, collection, cacheState, poster, refreshAfter);
  }
  return mediumWidget(ranking, collection, cacheState, poster, refreshAfter);
}

export default async function main(ctx) {
  let collection;
  const refreshHours = numberFrom(ctx.env?.REFRESH_HOURS, DEFAULT_REFRESH_HOURS);
  const refreshMs = refreshHours * HOUR;
  const timeoutSeconds = numberFrom(ctx.env?.REQUEST_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS);

  try {
    collection = selectedCollection(ctx.env);
    const { ranking, cacheState } = await loadRanking(ctx, collection, refreshMs, timeoutSeconds);
    const family = ctx.widgetFamily || 'systemMedium';
    const needsHeroDescription = family === 'systemLarge' || family === 'systemExtraLarge';
    const [poster, heroDescription] = await Promise.all([
      loadHeroPoster(ctx, ranking, collection, timeoutSeconds),
      needsHeroDescription
        ? loadHeroDescription(ctx, ranking, refreshMs, timeoutSeconds)
        : Promise.resolve(ranking.items[0]?.description || ''),
    ]);
    const displayRanking =
      heroDescription && ranking.items[0]?.description !== heroDescription
        ? {
            ...ranking,
            items: [{ ...ranking.items[0], description: heroDescription }, ...ranking.items.slice(1)],
          }
        : ranking;
    return renderWidget(
      family,
      displayRanking,
      collection,
      cacheState,
      poster,
      refreshDate(ranking, refreshMs),
    );
  } catch (error) {
    collection ||= selectedCollection({ COLLECTION_ID: 'show_global_best_weekly' });
    return errorWidget(collection, error?.message, new Date(Date.now() + refreshMs).toISOString());
  }
}
