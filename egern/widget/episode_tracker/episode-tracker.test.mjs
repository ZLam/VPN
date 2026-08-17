import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./episode-tracker.js', import.meta.url), 'utf8');
const manifest = await readFile(new URL('./episode-tracker.yaml', import.meta.url), 'utf8');
const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { default: renderWidget } = await import(moduleUrl);

const HOUR = 60 * 60 * 1000;

function refreshLabel(value) {
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `下次刷新 ${date.getMonth() + 1}月${date.getDate()}日 ${hours}:${minutes}`;
}

function allText(node) {
  if (!node || typeof node !== 'object') return '';
  const own = typeof node.text === 'string' ? node.text : '';
  const children = Array.isArray(node.children) ? node.children.map(allText).join('\n') : '';
  return [own, children].filter(Boolean).join('\n');
}

function tmdbPayload(id, name = `TMDB Official ${id}`, overrides = {}) {
  return {
    id: Number(id),
    name,
    original_name: `Original ${id}`,
    status: 'Returning Series',
    in_production: true,
    first_air_date: '2024-01-01',
    last_air_date: '2026-08-15',
    poster_path: `/poster-${id}.jpg`,
    last_episode_to_air: {
      id: Number(id) * 100 + 10,
      name: 'Latest Chapter',
      season_number: 2,
      episode_number: 10,
      air_date: '2026-08-15',
      show_id: Number(id),
    },
    next_episode_to_air: {
      id: Number(id) * 100 + 11,
      name: 'Next Chapter',
      season_number: 3,
      episode_number: 1,
      air_date: '2099-01-02',
      show_id: Number(id),
    },
    seasons: [
      { id: Number(id) * 10 + 2, season_number: 2, episode_count: 10, air_date: '2026-01-01' },
      { id: Number(id) * 10 + 3, season_number: 3, episode_count: 8, air_date: '2099-01-02' },
    ],
    ...overrides,
  };
}

function createContext({
  trackedShows = [{ name: 'User Lookup Name', id: '1' }],
  family = 'systemMedium',
  page = '1',
  token = 'test-token',
  language = 'zh-CN',
  store = new Map(),
  showNames = {},
  showOverrides = {},
  searchResults = {},
} = {}) {
  const calls = [];
  const controls = {
    failedShowIds: new Set(),
    failedSearches: new Set(),
    failedPosterPaths: new Set(),
    statusByShowId: new Map(),
    invalidToken: false,
  };

  const storage = {
    getJSON(key) {
      return store.get(key) ?? null;
    },
    setJSON(key, value) {
      store.set(key, value);
    },
  };

  const http = {
    async get(url, options) {
      calls.push({ url, options });

      if (controls.invalidToken) {
        return {
          status: 401,
          async json() {
            return { status_code: 7, status_message: 'Invalid API key' };
          },
        };
      }

      if (url.includes('/3/search/tv?')) {
        const query = new URL(url).searchParams.get('query');
        if (controls.failedSearches.has(query)) throw new Error('search offline');
        const results = searchResults[query] ?? [
          { id: 9, name: query, original_name: query },
        ];
        return {
          status: 200,
          async json() {
            return { page: 1, results, total_pages: 1, total_results: results.length };
          },
        };
      }

      if (url.startsWith('https://image.tmdb.org/t/p/w92/')) {
        const posterPath = new URL(url).pathname.replace('/t/p/w92', '');
        if (controls.failedPosterPaths.has(posterPath)) {
          return { status: 503, headers: {} };
        }
        return {
          status: 200,
          headers: {
            get(name) {
              return name.toLowerCase() === 'content-type' ? 'image/jpeg' : null;
            },
          },
          async arrayBuffer() {
            return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
          },
        };
      }

      const match = url.match(/\/3\/tv\/(\d+)\?/);
      if (match) {
        const id = match[1];
        if (controls.failedShowIds.has(id)) throw new Error('show offline');
        const status = controls.statusByShowId.get(id);
        if (status) {
          return {
            status,
            async json() {
              return { status_code: status };
            },
          };
        }
        return {
          status: 200,
          async json() {
            return tmdbPayload(id, showNames[id], showOverrides[id]);
          },
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  };

  return {
    ctx: {
      env: {
        TMDB_ACCESS_TOKEN: token,
        TMDB_LANGUAGE: language,
        TRACKED_SHOWS:
          typeof trackedShows === 'string' ? trackedShows : JSON.stringify(trackedShows),
        PAGE: page,
        REFRESH_HOURS: '24',
        REQUEST_TIMEOUT_SECONDS: '10',
      },
      widgetFamily: family,
      storage,
      http,
    },
    calls,
    controls,
    store,
  };
}

test('declares all editable TMDB module parameters in env_schema', () => {
  assert.match(manifest, /^env_schema:/m);
  for (const key of [
    'TMDB_ACCESS_TOKEN',
    'TMDB_LANGUAGE',
    'TRACKED_SHOWS',
    'PAGE',
    'REFRESH_HOURS',
    'REQUEST_TIMEOUT_SECONDS',
  ]) {
    assert.match(manifest, new RegExp(`^  ${key}:`, 'm'));
  }
});

test('renders an empty state without requiring a token or making a request', async () => {
  const { ctx, calls } = createContext({ trackedShows: [], token: '' });
  const widget = await renderWidget(ctx);

  assert.equal(widget.type, 'widget');
  assert.match(allText(widget), /还没有跟踪剧集/);
  assert.equal(calls.length, 0);
});

test('renders a separate configuration error for invalid JSON', async () => {
  const { ctx, calls } = createContext({ trackedShows: '{bad json' });
  const widget = await renderWidget(ctx);

  assert.match(allText(widget), /配置格式错误/);
  assert.match(allText(widget), /不是有效的 JSON/);
  assert.equal(calls.length, 0);
});

test('requires a TMDB access token only when shows need loading', async () => {
  const { ctx, calls } = createContext({ token: '' });
  const widget = await renderWidget(ctx);

  assert.match(allText(widget), /未配置 TMDB Token/);
  assert.equal(calls.length, 0);
});

test('loads a TMDB id with bearer auth and displays localized API data', async () => {
  const { ctx, calls } = createContext({
    trackedShows: [{ name: '用户搜索名称', id: '42' }],
    showNames: { 42: 'TMDB 本地化名称' },
  });
  const widget = await renderWidget(ctx);
  const renderedText = allText(widget);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/3\/tv\/42\?language=zh-CN/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.match(renderedText, /TMDB 本地化名称/);
  assert.doesNotMatch(renderedText, /用户搜索名称/);
  assert.match(renderedText, /S02E10/);
  assert.match(renderedText, /8月15日/);
  assert.match(renderedText, /S03E01/);
  assert.match(renderedText, /1月2日/);
  assert.doesNotMatch(renderedText, /21:00/);
});

test('displayName overrides TMDB names and changes without invalidating data cache', async () => {
  const setup = createContext({
    trackedShows: [{ name: 'Severance', id: '42', displayName: '人生切割术' }],
    showNames: { 42: '人生切割' },
  });

  const firstWidget = await renderWidget(setup.ctx);
  assert.match(allText(firstWidget), /人生切割术/);
  assert.doesNotMatch(allText(firstWidget), /人生切割\n/);
  assert.equal(setup.calls.length, 1);

  setup.ctx.env.TRACKED_SHOWS = JSON.stringify([
    { name: 'Severance', id: '42', displayName: '切割人生' },
  ]);
  const secondWidget = await renderWidget(setup.ctx);
  assert.match(allText(secondWidget), /切割人生/);
  assert.equal(setup.calls.length, 1, 'display-only changes should keep the fresh API cache');
});

test('falls back to original_name when localized TMDB name is empty', async () => {
  const { ctx } = createContext({
    trackedShows: [{ name: '', id: '44' }],
    showOverrides: { 44: { name: '', original_name: 'Original Series Name' } },
  });
  const widget = await renderWidget(ctx);

  assert.match(allText(widget), /Original Series Name/);
});

test('resolves a missing id by exact localized or original name', async () => {
  const { ctx, calls, store } = createContext({
    trackedShows: [{ name: 'Top Gear', id: '' }],
    searchResults: {
      'Top Gear': [
        { id: 2, name: 'Top Gear America', original_name: 'Top Gear America' },
        { id: 3, name: '英国疯狂汽车秀', original_name: 'Top Gear' },
      ],
    },
    showNames: { 3: '英国疯狂汽车秀' },
  });
  const widget = await renderWidget(ctx);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/3\/search\/tv\?/);
  assert.match(calls[0].url, /language=zh-CN/);
  assert.match(calls[1].url, /\/3\/tv\/3\?/);
  assert.match(allText(widget), /英国疯狂汽车秀/);
  assert.ok(
    [...store.keys()].some((key) =>
      key.startsWith('episode-tracker:tmdb:resolved-id:v1:'),
    ),
  );
});

test('fresh name and show caches avoid all subsequent HTTP requests', async () => {
  const setup = createContext({
    trackedShows: [{ name: 'Searchable Show', id: '' }],
    searchResults: {
      'Searchable Show': [
        { id: 15, name: 'Searchable Show', original_name: 'Searchable Show' },
      ],
    },
    showNames: { 15: 'TMDB Cached Show' },
  });

  await renderWidget(setup.ctx);
  assert.equal(setup.calls.length, 2);
  await renderWidget(setup.ctx);
  assert.equal(setup.calls.length, 2);
});

test('separates localized show caches by language', async () => {
  const setup = createContext({ trackedShows: [{ name: '', id: '16' }] });
  await renderWidget(setup.ctx);
  setup.ctx.env.TMDB_LANGUAGE = 'en-US';
  await renderWidget(setup.ctx);

  assert.equal(setup.calls.length, 2);
  assert.match(setup.calls[1].url, /language=en-US/);
});

test('uses stale TMDB show data when a daily refresh fails', async () => {
  const setup = createContext({
    trackedShows: [{ name: 'Alias', id: '8' }],
    showNames: { 8: 'Cached TMDB Show' },
  });

  await renderWidget(setup.ctx);
  const cacheKey = [...setup.store.keys()].find((key) =>
    key.startsWith('episode-tracker:tmdb:show:v1:zh-CN:8'),
  );
  const cached = setup.store.get(cacheKey);
  setup.store.set(cacheKey, { ...cached, fetchedAt: Date.now() - 25 * HOUR });
  setup.controls.failedShowIds.add('8');

  const widget = await renderWidget(setup.ctx);
  assert.match(allText(widget), /Cached TMDB Show/);
  assert.match(allText(widget), /缓存/);
});

test('keeps rendering other shows when one TMDB item fails', async () => {
  const setup = createContext({
    trackedShows: [
      { name: 'First Alias', id: '1' },
      { name: 'Broken Alias', id: '2', displayName: '加载失败的剧' },
    ],
    showNames: { 1: 'Working TMDB Show' },
  });
  setup.controls.statusByShowId.set('2', 404);

  const widget = await renderWidget(setup.ctx);
  const renderedText = allText(widget);
  assert.match(renderedText, /Working TMDB Show/);
  assert.match(renderedText, /加载失败的剧/);
  assert.match(renderedText, /部分失败/);
  assert.match(renderedText, /找不到对应的 TMDB 剧集/);
});

test('medium pagination requests only three TMDB shows from the selected page', async () => {
  const setup = createContext({
    trackedShows: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ name: '', id: String(id) })),
    page: '2',
  });
  const widget = await renderWidget(setup.ctx);
  const showCalls = setup.calls.filter((call) => call.url.includes('/3/tv/'));

  assert.equal(showCalls.length, 3);
  assert.match(showCalls[0].url, /\/3\/tv\/4\?/);
  assert.match(showCalls[2].url, /\/3\/tv\/6\?/);
  assert.match(allText(widget), /2\/3/);
  assert.doesNotMatch(allText(widget), /TMDB Official 1/);
});

test('large widgets show five entries with posters and episode details', async () => {
  const setup = createContext({
    trackedShows: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ name: '', id: String(id) })),
    family: 'systemLarge',
  });
  const widget = await renderWidget(setup.ctx);

  assert.equal(setup.calls.filter((call) => call.url.includes('/3/tv/')).length, 5);
  assert.equal(
    setup.calls.filter((call) => call.url.startsWith('https://image.tmdb.org/')).length,
    5,
  );
  assert.match(allText(widget), /Latest Chapter/);
  assert.match(allText(widget), /Next Chapter/);
  assert.match(allText(widget), /1\/2/);

  const firstRow = widget.children[1].children[0];
  assert.equal(firstRow.direction, 'row');
  assert.equal(firstRow.children.length, 2);
  assert.equal(firstRow.alignItems, 'center');
  assert.equal(firstRow.height, 51);
  assert.deepEqual(firstRow.padding, [2, 8, 2, 5]);

  const poster = firstRow.children[0];
  assert.equal(poster.type, 'image');
  assert.match(poster.src, /^data:image\/jpeg;base64,/);
  assert.equal(poster.width, 30);
  assert.equal(poster.height, 45);
  assert.equal(poster.resizeMode, 'cover');

  const details = firstRow.children[1];
  assert.equal(details.direction, 'column');
  assert.equal(details.alignItems, 'start');
  assert.equal(details.height, 45);
  assert.match(allText(details.children[1]), /^已播 /);
  assert.match(allText(details.children[2]), /^下集 /);
  assert.equal(details.children[1].textAlign, 'left');
  assert.equal(details.children[2].textAlign, 'left');
});

test('large widgets cache posters and fall back to a placeholder when loading fails', async () => {
  const cachedSetup = createContext({ family: 'systemLarge' });
  const firstWidget = await renderWidget(cachedSetup.ctx);
  const firstPoster = firstWidget.children[1].children[0].children[0];
  assert.match(firstPoster.src, /^data:image\/jpeg;base64,/);
  assert.equal(cachedSetup.calls.length, 2);

  await renderWidget(cachedSetup.ctx);
  assert.equal(cachedSetup.calls.length, 2, 'fresh show and poster caches should avoid requests');
  assert.ok(
    [...cachedSetup.store.keys()].some((key) =>
      key.startsWith('episode-tracker:tmdb:poster:v1:'),
    ),
  );

  const failedSetup = createContext({ family: 'systemLarge' });
  failedSetup.controls.failedPosterPaths.add('/poster-1.jpg');
  const failedWidget = await renderWidget(failedSetup.ctx);
  const fallbackPoster = failedWidget.children[1].children[0].children[0];
  assert.equal(fallbackPoster.src, 'sf-symbol:photo.fill');
  assert.match(allText(failedWidget), /TMDB Official 1/);
});

test('distinguishes whole-show, season-complete, and scheduling states', async () => {
  const previousEpisode = {
    id: 100,
    name: 'Episode 10',
    season_number: 1,
    episode_number: 10,
    air_date: '2000-07-23',
  };
  const setup = createContext({
    family: 'systemLarge',
    trackedShows: [20, 21, 22, 23].map((id) => ({ name: '', id: String(id) })),
    showOverrides: {
      20: {
        status: 'Ended',
        last_episode_to_air: previousEpisode,
        next_episode_to_air: null,
        seasons: [{ season_number: 1, episode_count: 10, air_date: '2000-01-01' }],
      },
      21: {
        status: 'Returning Series',
        last_episode_to_air: previousEpisode,
        next_episode_to_air: null,
        seasons: [{ season_number: 1, episode_count: 10, air_date: '2000-01-01' }],
      },
      22: {
        status: 'Returning Series',
        last_episode_to_air: previousEpisode,
        next_episode_to_air: null,
        seasons: [{ season_number: 1, episode_count: 12, air_date: '2000-01-01' }],
      },
      23: {
        status: 'Unknown',
        last_episode_to_air: previousEpisode,
        next_episode_to_air: null,
        seasons: [{ season_number: 1, episode_count: 12, air_date: '2000-01-01' }],
      },
    },
  });
  const widget = await renderWidget(setup.ctx);
  const renderedText = allText(widget);

  assert.match(renderedText, /全剧已完结/);
  assert.match(renderedText, /本季已播完/);
  assert.match(renderedText, /后续待定/);
  assert.match(renderedText, /下集未定/);
});

test('next episode data takes priority over an ended status', async () => {
  const setup = createContext({
    trackedShows: [{ name: '', id: '24' }],
    showOverrides: { 24: { status: 'Ended' } },
  });
  const widget = await renderWidget(setup.ctx);

  assert.match(allText(widget), /下集 S03E01/);
  assert.doesNotMatch(allText(widget), /全剧已完结/);
});

test('shows future and unknown episode dates without crashing', async () => {
  const setup = createContext({
    trackedShows: [
      { name: '', id: '30' },
      { name: '', id: '31' },
    ],
    showOverrides: {
      30: {
        status: 'Planned',
        first_air_date: '2099-01-01',
        last_episode_to_air: null,
        next_episode_to_air: null,
        seasons: [],
      },
      31: {
        next_episode_to_air: {
          id: 3101,
          name: 'Unscheduled',
          season_number: 1,
          episode_number: 1,
          air_date: '',
        },
      },
    },
  });
  const widget = await renderWidget(setup.ctx);
  const renderedText = allText(widget);

  assert.match(renderedText, /尚未开播/);
  assert.match(renderedText, /待公布/);
});

test('renders a dedicated state for an invalid TMDB token', async () => {
  const setup = createContext();
  setup.controls.invalidToken = true;
  const widget = await renderWidget(setup.ctx);

  assert.match(allText(widget), /TMDB Token 无效/);
  assert.equal(setup.calls.length, 1);
});

test('invalid pages and unsupported sizes do not make requests', async () => {
  const invalidPage = createContext({
    trackedShows: [{ name: '', id: '1' }],
    page: '2',
  });
  const pageWidget = await renderWidget(invalidPage.ctx);
  assert.match(allText(pageWidget), /这一页没有剧集/);
  assert.ok(allText(pageWidget).includes(refreshLabel(pageWidget.refreshAfter)));
  assert.equal(invalidPage.calls.length, 0);

  const unsupported = createContext({ family: 'systemSmall' });
  const unsupportedWidget = await renderWidget(unsupported.ctx);
  assert.match(allText(unsupportedWidget), /不支持当前尺寸/);
  assert.equal(unsupported.calls.length, 0);
});

test('uses a daily refresh date and TMDB attribution link', async () => {
  const { ctx } = createContext();
  const before = Date.now();
  const widget = await renderWidget(ctx);
  const refreshAt = new Date(widget.refreshAfter).getTime();

  assert.ok(refreshAt >= before + 23.9 * HOUR);
  assert.ok(refreshAt <= Date.now() + 24.1 * HOUR);
  assert.equal(widget.url, 'https://www.themoviedb.org');
  assert.match(allText(widget), /Data: TMDB/);
  assert.ok(allText(widget).includes(refreshLabel(widget.refreshAfter)));
});

test('contains no TVmaze endpoint, branding, or legacy cache namespace', () => {
  for (const content of [source, manifest, readme]) {
    assert.doesNotMatch(content, /api\.tvmaze\.com/i);
    assert.doesNotMatch(content, /Data: TVmaze/i);
  }
  assert.doesNotMatch(source, /episode-tracker:show:v2:/);
  assert.match(source, /episode-tracker:tmdb:show:v1:/);
});
