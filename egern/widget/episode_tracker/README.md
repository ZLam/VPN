# TMDB 剧集追踪 Widget

一个使用 TMDB 数据跟踪剧集播出进度的 Egern Widget，显示剧名、最近已播集及日期、下一集及日期。

仅为中号和大号主屏幕 Widget 设计：

- 中号：每页显示 3 部剧。
- 大号：每页显示 5 部剧，显示剧集海报并补充单集名称。
- 超出一页时使用 `PAGE` 分页，只请求当前页的剧集。
- 成功数据缓存 24 小时，请求失败时显示最近一次缓存。

## 安装

在 Egern 中打开“工具 → 模块 → +”，添加：

```text
https://raw.githubusercontent.com/ZLam/VPN/refs/heads/main/egern/widget/episode_tracker/episode-tracker.yaml
```

启用模块后，进入“分析 → Widget Gallery”，将“剧集追踪”以中号或大号添加到主屏幕。

## 获取并配置 TMDB Token

1. 登录 [TMDB](https://www.themoviedb.org)。
2. 进入账户设置中的 API 页面，申请免费的 Developer API。
3. 申请通过后复制 `API Read Access Token`。
4. 在 Egern 模块编辑页面将它填入 `TMDB_ACCESS_TOKEN`。

Widget 使用 Bearer Token 请求 TMDB。Token 仅应保存在个人设备中，不要写入公开 YAML、GitHub、日志或截图。

没有配置 Token 时，Widget 会显示配置提示；Token 无效时会显示单独的鉴权错误。

## 配置剧集

`TRACKED_SHOWS` 必须是一份 JSON 数组，字段结构保持不变，并新增可选的 `displayName`：

```json
[
  {"name":"Severance","id":"","displayName":"人生切割术"},
  {"name":"Silo","id":"","displayName":""}
]
```

| 字段 | 必填条件 | 说明 |
| --- | --- | --- |
| `id` | `name` 为空时必填 | TMDB TV ID；填写后直接请求该剧。 |
| `name` | `id` 为空时必填 | 没有 ID 时用于搜索 TMDB，支持原名和译名。 |
| `displayName` | 可选 | Widget 显示名称；不参与搜索或缓存。 |

剧名显示优先级：

1. 非空 `displayName`
2. TMDB 按 `TMDB_LANGUAGE` 返回的 `name`
3. TMDB 的 `original_name`
4. 请求失败且没有缓存时使用配置中的 `name`

修改 `displayName` 可以立即生效，不需要等待每日数据缓存刷新。

### TMDB ID

TMDB 电视剧页面地址中的 `/tv/` 后数字就是 TV ID：

```text
https://www.themoviedb.org/tv/1399-game-of-thrones
                                 ^^^^
```

也可以把 `id` 留空，让 Widget 首次运行时根据 `name` 搜索并缓存 TMDB ID。同名或重拍剧集建议手动填写 ID。

> 从旧版本迁移时，原有数据源的 ID 不能作为 TMDB ID 使用。更新模块前请清空全部旧 ID，让脚本按名称重新搜索，或手动替换为 TMDB TV ID。数字相同不代表同一部剧。

## 分页

一份 `TRACKED_SHOWS` 可以供不同尺寸或多个 Widget 共用：

```yaml
PAGE: '1'
```

- 中号第 1 页显示第 1–3 项，第 2 页显示第 4–6 项。
- 大号第 1 页显示第 1–5 项，第 2 页显示第 6–10 项。
- 标题右侧显示当前页和总页数，例如 `2/3`。
- 可在模块中复制 `widgets` 条目并配置不同 `PAGE`，各页面共用逐剧缓存。

## 数据和状态规则

- 剧集详情来自 `GET /3/tv/{id}`，名称搜索来自 `GET /3/search/tv`。
- 最近已播集使用 `last_episode_to_air`，显示 `S02E08 · 8月15日`。
- 下一集使用 `next_episode_to_air`，显示 `S02E09 · 8月22日`。
- 大号布局左侧显示 TMDB 剧集海报，右侧分三行显示剧名、最近已播集和下一集，并显示单集名称。
- 日期只显示“今天”“明天”或具体月日，不显示播出时刻。
- 日期缺失时，已播集显示“日期未知”，下一集显示“待公布”。
- `status` 为 `Ended` 或 `Canceled` 且没有下一集时显示“全剧已完结”。
- 最新集编号达到当前季 `episode_count` 时显示“本季已播完”。
- `Returning Series`、`Planned`、`In Production` 或 `Pilot` 没有下一集时显示“后续待定”。
- 其他没有下一集资料的状态显示“下集未定”。

TMDB 没有季结束日期；“本季已播完”是根据当前已知的 `episode_count` 推断，数据不完整时可能暂时显示“后续待定”或产生误判。

## 缓存和异常处理

- 每部剧按 TMDB ID 和数据语言单独缓存。
- 大号使用的海报转换为 Base64 后单独缓存；缺少海报或下载失败时显示占位图。
- 成功数据在 `REFRESH_HOURS` 内不重复请求，默认 24 小时。
- 名称到 TMDB ID 的解析结果单独缓存。
- 修改 `displayName` 不会让数据缓存失效。
- 添加新剧只请求新增条目。
- 单部剧获取失败不影响其他剧集。
- 请求失败时优先显示旧缓存并标记“缓存”。
- 空配置和无效页码不会发送网络请求。
- Widget 底部显示根据 `refreshAfter` 计算的下次预计刷新时间。
- `refreshAfter` 是提交给 iOS 的最早刷新时间，实际刷新可能稍晚。
- 缓存使用全新的 TMDB 命名空间，不会读取旧版本的数据缓存。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TMDB_ACCESS_TOKEN` | 空 | 必填的 API Read Access Token。 |
| `TMDB_LANGUAGE` | `zh-CN` | TMDB 返回内容的本地化语言。 |
| `TRACKED_SHOWS` | `[]` | 跟踪剧集 JSON。 |
| `PAGE` | `1` | 当前页码，从 1 开始。 |
| `REFRESH_HOURS` | `24` | 成功数据缓存和刷新间隔。 |
| `REQUEST_TIMEOUT_SECONDS` | `10` | 单次 TMDB 请求超时。 |

## TMDB 署名

本 Widget 底部保留 `Data: TMDB` 并链接到 TMDB。

This product uses the TMDB API but is not endorsed or certified by TMDB.

TMDB 数据和品牌使用应遵守 [TMDB API 条款与署名要求](https://developer.themoviedb.org/docs/faq)。

## 文件和测试

- `episode-tracker.js`：Egern Generic Widget 脚本。
- `episode-tracker.yaml`：可直接安装的 Egern 模块。
- `episode-tracker.test.mjs`：不依赖第三方包的 Node.js 行为测试。

```shell
node --test egern/widget/episode_tracker/episode-tracker.test.mjs
```
