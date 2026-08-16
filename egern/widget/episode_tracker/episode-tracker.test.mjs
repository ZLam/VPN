import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./episode-tracker.js', import.meta.url), 'utf8');
const manifest = await readFile(new URL('./episode-tracker.yaml', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { default: renderWidget } = await import(moduleUrl);

const HOUR = 60 * 60 * 1000;

function allText(node) {
  if (!node || typeof node !== 'object') return '';
  const own = typeof node.text === 'string' ? node.text : '';
  const children = Array.isArray(node.children) ? node.children.map(allText).join('\n') : '';
  return [own, children].filter(Boolean).join('\n');
}

function showPayload(id, name = `TVmaze Official ${id}`, overrides = {}) {
  const nextEpisode = {
    id: Number(id) * 100 + 11,
    name: 'Next Chapter',
    season: 3,
    number: 1,
    type: 'regular',
    airdate: '2099-01-02',
    airtime: '21:00',
    airstamp: '2099-01-02T21:00:00+08:00',
    url: `https://www.tvmaze.com/episodes/${id}11`,
  };

  return {
    id: Number(id),
    name,
    status: 'Running',
    premiered: '2024-01-01',
    ended: null,
    url: `https://www.tvmaze.com/shows/${id}/official-${id}`,
    _embedded: {
      previousepisode: {
        id: Number(id) * 100 + 10,
        name: 'Latest Chapter',
        season: 2,
        number: 10,
        type: 'regular',
        airdate: '2026-08-15',
        airtime: '21:00',
        airstamp: '2026-08-15T21:00:00+08:00',
        url: `https://www.tvmaze.com/episodes/${id}10`,
      },
      nextepisode: nextEpisode,
      seasons: [],
    },
    ...overrides,
  };
}

function createContext({
  trackedShows = [{ name: 'User Alias', id: '1' }],
  family = 'systemMedium',
  page = '1',
  store = new Map(),
  showNames = {},
  showOverrides = {},
  searchResults = {},
} = {}) {
  const calls = [];
  const controls = { failedShowIds: new Set(), failedSearches: new Set() };

  const storage = {
    getJSON(key) {
      return store.get(key) ?? null;
    },
    setJSON(key, value) {
      store.set(key, value);
    },
  };

  const http = {
    async get(url) {
      calls.push(url);

      if (url.includes('/search/shows?')) {
        const query = new URL(url).searchParams.get('q');
        if (controls.failedSearches.has(query)) throw new Error('search offline');
        const results = searchResults[query] ?? [
          { score: 1, show: { id: 9, name: query } },
        ];
        return {
          status: 200,
          async json() {
            return results;
          },
        };
      }

      const match = url.match(/\/shows\/(\d+)\?/);
      if (match) {
        const id = match[1];
        if (controls.failedShowIds.has(id)) throw new Error('show offline');
        return {
          status: 200,
          async json() {
            return showPayload(id, showNames[id], showOverrides[id]);
          },
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  };

  return {
    ctx: {
      env: {
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

test('declares editable module parameters in env_schema', () => {
  assert.match(manifest, /^env_schema:/m);
  for (const key of [
    'TRACKED_SHOWS',
    'PAGE',
    'REFRESH_HOURS',
    'REQUEST_TIMEOUT_SECONDS',
  ]) {
    assert.match(manifest, new RegExp(`^  ${key}:`, 'm'));
  }
});

test('renders an empty state without making a request', async () => {
  const { ctx, calls } = createContext({ trackedShows: [] });
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

test('uses an explicit id and always displays the TVmaze show name', async () => {
  const { ctx, calls } = createContext({
    trackedShows: [{ name: '用户填写的名字', id: '42' }],
    showNames: { 42: 'Official TVmaze Name' },
  });
  const widget = await renderWidget(ctx);
  const renderedText = allText(widget);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/shows\/42\?/);
  assert.match(calls[0], /embed%5B%5D=seasons/);
  assert.match(renderedText, /Official TVmaze Name/);
  assert.doesNotMatch(renderedText, /用户填写的名字/);
  assert.match(renderedText, /S02E10/);
  assert.match(renderedText, /8月15日/);
  assert.match(renderedText, /S03E01/);
  assert.match(renderedText, /1月2日/);
  assert.doesNotMatch(renderedText, /21:00/);
});

test('resolves a missing id by exact name before loading the show', async () => {
  const { ctx, calls, store } = createContext({
    trackedShows: [{ name: 'Top Gear', id: '' }],
    searchResults: {
      'Top Gear': [
        { score: 0.99, show: { id: 2, name: 'Top Gear America' } },
        { score: 0.95, show: { id: 3, name: 'Top Gear' } },
      ],
    },
    showNames: { 3: 'Top Gear (TVmaze)' },
  });
  const widget = await renderWidget(ctx);

  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/search\/shows\?/);
  assert.match(calls[1], /\/shows\/3\?/);
  assert.match(allText(widget), /Top Gear \(TVmaze\)/);
  assert.ok([...store.keys()].some((key) => key.startsWith('episode-tracker:resolved-id:v1:')));
});

test('fresh id and show caches avoid every subsequent HTTP request', async () => {
  const setup = createContext({
    trackedShows: [{ name: 'Searchable Show', id: '' }],
    searchResults: {
      'Searchable Show': [{ score: 1, show: { id: 15, name: 'Searchable Show' } }],
    },
    showNames: { 15: 'Official Cached Show' },
  });

  await renderWidget(setup.ctx);
  assert.equal(setup.calls.length, 2);
  await renderWidget(setup.ctx);
  assert.equal(setup.calls.length, 2);
});

test('uses stale show data when a daily refresh fails', async () => {
  const setup = createContext({
    trackedShows: [{ name: 'Alias', id: '8' }],
    showNames: { 8: 'Cached Official Show' },
  });

  await renderWidget(setup.ctx);
  const cacheKey = [...setup.store.keys()].find((key) =>
    key.startsWith('episode-tracker:show:v2:8'),
  );
  const cached = setup.store.get(cacheKey);
  setup.store.set(cacheKey, { ...cached, fetchedAt: Date.now() - 25 * HOUR });
  setup.controls.failedShowIds.add('8');

  const widget = await renderWidget(setup.ctx);
  assert.match(allText(widget), /Cached Official Show/);
  assert.match(allText(widget), /缓存/);
});

test('keeps rendering other shows when one item fails', async () => {
  const setup = createContext({
    trackedShows: [
      { name: 'First Alias', id: '1' },
      { name: 'Broken Alias', id: '2' },
    ],
    showNames: { 1: 'Working Official Show' },
  });
  setup.controls.failedShowIds.add('2');

  const widget = await renderWidget(setup.ctx);
  const renderedText = allText(widget);
  assert.match(renderedText, /Working Official Show/);
  assert.match(renderedText, /Broken Alias/);
  assert.match(renderedText, /部分失败/);
  assert.match(renderedText, /获取失败/);
});

test('medium pagination requests only three shows from the selected page', async () => {
  const setup = createContext({
    trackedShows: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ name: '', id: String(id) })),
    page: '2',
  });
  const widget = await renderWidget(setup.ctx);
  const showCalls = setup.calls.filter((url) => url.includes('/shows/'));

  assert.equal(showCalls.length, 3);
  assert.match(showCalls[0], /\/shows\/4\?/);
  assert.match(showCalls[2], /\/shows\/6\?/);
  assert.match(allText(widget), /2\/3/);
  assert.doesNotMatch(allText(widget), /TVmaze Official 1/);
});

test('large widgets show seven entries and include episode names', async () => {
  const setup = createContext({
    trackedShows: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ name: '', id: String(id) })),
    family: 'systemLarge',
  });
  const widget = await renderWidget(setup.ctx);

  assert.equal(setup.calls.filter((url) => url.includes('/shows/')).length, 7);
  assert.match(allText(widget), /Latest Chapter/);
  assert.match(allText(widget), /Next Chapter/);
  assert.match(allText(widget), /1\/2/);
});

test('shows ended and unscheduled states without crashing', async () => {
  const setup = createContext({
    trackedShows: [
      { name: '', id: '20' },
      { name: '', id: '21' },
    ],
    showOverrides: {
      20: { status: 'Ended', _embedded: { previousepisode: null, nextepisode: null } },
      21: {
        _embedded: {
          previousepisode: null,
          nextepisode: {
            id: 2101,
            name: 'Unscheduled',
            season: 1,
            number: 1,
            airdate: '',
            airtime: '',
            airstamp: '',
          },
        },
      },
    },
  });
  const widget = await renderWidget(setup.ctx);
  const renderedText = allText(widget);

  assert.match(renderedText, /全剧已完结/);
  assert.match(renderedText, /待公布/);
  assert.match(renderedText, /暂无记录/);
  assert.doesNotMatch(renderedText, /尚未开播/);
});

test('distinguishes season completion from whole-show and scheduling states', async () => {
  const previousEpisode = {
    id: 9221510,
    name: 'Episode 10',
    season: 1,
    number: 10,
    type: 'regular',
    airdate: '2000-07-23',
    airtime: '20:40',
    airstamp: '2000-07-23T11:40:00+00:00',
  };
  const setup = createContext({
    family: 'systemLarge',
    trackedShows: [92215, 23, 24, 25].map((id) => ({ name: '', id: String(id) })),
    showOverrides: {
      92215: {
        status: 'To Be Determined',
        ended: null,
        _embedded: {
          previousepisode: previousEpisode,
          nextepisode: null,
          seasons: [
            {
              number: 1,
              episodeOrder: null,
              premiereDate: '2000-05-21',
              endDate: '2000-07-23',
            },
          ],
        },
      },
      23: {
        status: 'Running',
        _embedded: {
          previousepisode: previousEpisode,
          nextepisode: null,
          seasons: [{ number: 1, episodeOrder: 10, endDate: null }],
        },
      },
      24: {
        status: 'To Be Determined',
        _embedded: {
          previousepisode: previousEpisode,
          nextepisode: null,
          seasons: [{ number: 1, episodeOrder: 12, endDate: null }],
        },
      },
      25: {
        status: 'Running',
        _embedded: {
          previousepisode: previousEpisode,
          nextepisode: null,
          seasons: [{ number: 1, episodeOrder: null, endDate: null }],
        },
      },
    },
  });
  const widget = await renderWidget(setup.ctx);
  const renderedText = allText(widget);

  assert.match(renderedText, /本季已播完/);
  assert.match(renderedText, /后续待定/);
  assert.match(renderedText, /下集未定/);
  assert.doesNotMatch(renderedText, /下集 本季已播完/);
});

test('only calls a show not yet aired when its premiere date is in the future', async () => {
  const setup = createContext({
    trackedShows: [{ name: '', id: '22' }],
    showOverrides: {
      22: {
        premiered: '2099-01-01',
        _embedded: { previousepisode: null, nextepisode: null },
      },
    },
  });
  const widget = await renderWidget(setup.ctx);

  assert.match(allText(widget), /尚未开播/);
});

test('invalid pages and unsupported sizes do not make requests', async () => {
  const invalidPage = createContext({
    trackedShows: [{ name: '', id: '1' }],
    page: '2',
  });
  const pageWidget = await renderWidget(invalidPage.ctx);
  assert.match(allText(pageWidget), /这一页没有剧集/);
  assert.equal(invalidPage.calls.length, 0);

  const unsupported = createContext({ family: 'systemSmall' });
  const unsupportedWidget = await renderWidget(unsupported.ctx);
  assert.match(allText(unsupportedWidget), /不支持当前尺寸/);
  assert.equal(unsupported.calls.length, 0);
});

test('sets a roughly daily refresh date after a live request', async () => {
  const { ctx } = createContext();
  const before = Date.now();
  const widget = await renderWidget(ctx);
  const refreshAt = new Date(widget.refreshAfter).getTime();

  assert.ok(refreshAt >= before + 23.9 * HOUR);
  assert.ok(refreshAt <= Date.now() + 24.1 * HOUR);
  assert.equal(widget.url, 'https://www.tvmaze.com');
  assert.match(allText(widget), /Data: TVmaze/);
});
