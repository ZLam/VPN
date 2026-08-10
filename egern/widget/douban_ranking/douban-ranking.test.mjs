import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./douban-ranking.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { default: renderWidget } = await import(moduleUrl);

function urlsIn(node) {
  if (!node || typeof node !== 'object') return [];
  const urls = typeof node.url === 'string' ? [node.url] : [];
  if (!Array.isArray(node.children)) return urls;
  return urls.concat(node.children.flatMap(urlsIn));
}

function payload(name = '国外口碑综艺榜') {
  return {
    total: 3,
    subject_collection: {
      name,
      updated_at: '2026-08-05 16:29:23',
    },
    subject_collection_items: [
      {
        id: '1',
        rank: 1,
        title: '榜首节目',
        rating: { value: 9.6, count: 12000 },
        card_subtitle: '2026 / 英国 / 真人秀',
        description: '榜首简介',
        tags: [{ name: '真人秀' }],
        cover_url: 'https://img.example/poster.jpg',
        photos: ['https://img.example/photo.jpg'],
        trend_equal: true,
        rank_value_changed: 0,
        sharing_url: 'https://www.douban.com/doubanapp/dispatch/movie/1',
        url: 'https://movie.douban.com/subject/1/',
        uri: 'douban://douban.com/tv/1',
      },
      {
        id: '2',
        rank: 2,
        title: '第二名',
        rating: { value: 9.1, count: 5000 },
        tags: [{ name: '连续上榜2周' }],
        trend_up: true,
        rank_value_changed: 1,
        url: 'https://movie.douban.com/subject/2/',
      },
      {
        id: '3',
        rank: 3,
        title: '第三名',
        rating: { value: 8.7, count: 1000 },
        tags: [],
        trend_down: true,
        rank_value_changed: 2,
        url: 'https://movie.douban.com/subject/3/',
      },
    ],
  };
}

function createContext({
  collectionId = 'show_global_best_weekly',
  family = 'systemMedium',
  apiPayload = payload(),
  detailPayload = { intro: '详情接口简介' },
  failApi = false,
  store = new Map(),
} = {}) {
  const calls = [];
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
      if (url.includes('/items?')) {
        if (failApi) throw new Error('offline');
        return {
          status: 200,
          async json() {
            return apiPayload;
          },
        };
      }

      if (/\/rexxar\/api\/v2\/(?:movie|tv)\//.test(url)) {
        return {
          status: 200,
          async json() {
            return detailPayload;
          },
        };
      }

      return {
        status: 200,
        headers: { get: () => 'image/jpeg' },
        async arrayBuffer() {
          return Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer;
        },
      };
    },
  };

  return {
    ctx: {
      env: {
        COLLECTION_ID: collectionId,
        REFRESH_HOURS: '24',
        REQUEST_TIMEOUT_SECONDS: '10',
      },
      widgetFamily: family,
      storage,
      http,
    },
    calls,
    store,
  };
}

test('renders all supported widget families', async () => {
  const families = [
    'systemSmall',
    'systemMedium',
    'systemLarge',
    'systemExtraLarge',
    'accessoryCircular',
    'accessoryRectangular',
    'accessoryInline',
  ];

  for (const family of families) {
    const { ctx } = createContext({ family });
    const widget = await renderWidget(ctx);
    assert.equal(widget.type, 'widget');
    assert.match(widget.refreshAfter, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Array.isArray(widget.children));
  }
});

test('uses exactly one ranking URL for every widget family', async () => {
  const families = [
    'systemSmall',
    'systemMedium',
    'systemLarge',
    'systemExtraLarge',
    'accessoryCircular',
    'accessoryRectangular',
    'accessoryInline',
  ];

  for (const family of families) {
    const { ctx } = createContext({ family });
    const widget = await renderWidget(ctx);
    assert.deepEqual(urlsIn(widget), [
      'https://m.douban.com/subject_collection/show_global_best_weekly',
    ]);
  }
});

test('keeps small ranking rows in a fixed compact list', async () => {
  const { ctx } = createContext({ family: 'systemSmall' });
  const widget = await renderWidget(ctx);
  const compactList = widget.children.at(-1);

  assert.equal(compactList.type, 'stack');
  assert.equal(compactList.direction, 'column');
  assert.equal(compactList.height, 33);
  assert.equal(compactList.children.length, 2);
  assert.deepEqual(
    compactList.children.map((row) => row.height),
    [15, 15],
  );
});

test('uses the requested collection id and caches data plus the hero poster', async () => {
  const { ctx, calls, store } = createContext({
    collectionId: 'tv_global_best_weekly',
    apiPayload: payload('全球口碑剧集榜'),
  });

  const widget = await renderWidget(ctx);
  assert.equal(widget.type, 'widget');
  assert.match(calls[0], /tv_global_best_weekly\/items/);
  assert.equal(calls.length, 2);
  assert.ok(store.has('douban-ranking:data:tv_global_best_weekly'));
  assert.ok(store.has('douban-ranking:poster:tv_global_best_weekly'));

  await renderWidget(ctx);
  assert.equal(calls.length, 2, 'fresh cache should avoid API and image requests');
});

test('loads and caches the hero intro when the ranking item has no description', async () => {
  const apiPayload = payload();
  apiPayload.subject_collection_items[0].description = '';
  const { ctx, calls, store } = createContext({ family: 'systemLarge', apiPayload });

  const widget = await renderWidget(ctx);
  assert.match(JSON.stringify(widget), /详情接口简介/);
  assert.ok(calls.some((url) => url.endsWith('/tv/1')));
  assert.ok(store.has('douban-ranking:description:1'));

  await renderWidget(ctx);
  assert.equal(
    calls.filter((url) => url.endsWith('/tv/1')).length,
    1,
    'fresh description cache should avoid another detail request',
  );
});

test('uses a compact hero title row unless the title needs two lines', async () => {
  const shortContext = createContext({ family: 'systemLarge' });
  const shortWidget = await renderWidget(shortContext.ctx);
  const shortTitleRow = shortWidget.children[1].children[1].children[0];
  assert.equal(shortTitleRow.height, 20);
  assert.equal(shortTitleRow.children[1].maxLines, 1);

  const longPayload = payload();
  longPayload.subject_collection_items[0].title = '孤单又灿烂的神：鬼怪十周年特辑';
  const longContext = createContext({ family: 'systemLarge', apiPayload: longPayload });
  const longWidget = await renderWidget(longContext.ctx);
  const longTitleRow = longWidget.children[1].children[1].children[0];
  assert.equal(longTitleRow.height, 38);
  assert.equal(longTitleRow.children[1].maxLines, 2);
});

test('falls back to stale cached ranking when the API fails', async () => {
  const store = new Map();
  const cached = {
    collectionId: 'show_global_best_weekly',
    name: '国外口碑综艺榜',
    shortName: '国外综艺',
    updatedAt: '2026-08-03 20:29:49',
    fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
    total: 1,
    listUrl: 'https://m.douban.com/subject_collection/show_global_best_weekly',
    items: [
      {
        rank: 1,
        title: '缓存榜首',
        rating: 9.6,
        ratingCount: 100,
        subtitle: '',
        description: '',
        tags: [],
        cover: '',
        photos: [],
        trend: 'equal',
        trendValue: 0,
        webUrl: 'https://movie.douban.com/subject/1/',
        appUri: '',
        link: 'https://movie.douban.com/subject/1/',
      },
    ],
  };
  store.set('douban-ranking:data:show_global_best_weekly', cached);
  const { ctx } = createContext({ family: 'systemSmall', failApi: true, store });

  const widget = await renderWidget(ctx);
  assert.equal(widget.type, 'widget');
  assert.doesNotMatch(JSON.stringify(widget), /暂时无法更新/);
  assert.match(JSON.stringify(widget), /缓存/);
});

test('returns an error widget for unsupported collection ids', async () => {
  const { ctx } = createContext({ collectionId: 'unknown_collection' });
  const widget = await renderWidget(ctx);
  assert.equal(widget.type, 'widget');
  assert.match(JSON.stringify(widget), /暂时无法更新/);
});
