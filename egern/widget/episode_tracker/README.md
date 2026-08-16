# TVmaze 剧集追踪 Widget

一个用于跟踪剧集播出进度的 Egern Widget。数据来自 TVmaze，显示官方剧名、最近已播集、下一集以及下一集播出时间。

仅为中号和大号主屏幕 Widget 设计：

- 中号：每页显示 3 部剧。
- 大号：每页显示 7 部剧，并补充单集名称。
- 超出一页时使用 `PAGE` 分页，不会在后台请求当前页之外的剧集。

## 安装

在 Egern 中打开“工具 → 模块 → +”，添加以下模块地址：

```text
https://raw.githubusercontent.com/ZLam/VPN/refs/heads/main/egern/widget/episode_tracker/episode-tracker.yaml
```

启用模块后，进入“分析 → Widget Gallery”，将“剧集追踪”以中号或大号添加到主屏幕。

模块会在编辑页面自动显示以下可调参数：

- 跟踪剧集 JSON
- 显示页码
- 数据刷新间隔（小时）
- 请求超时（秒）

如果模块是在加入 `env_schema` 之前安装的，请先刷新远程模块；仍未显示时删除后重新添加一次。

## 配置剧集

编辑模块中的 `TRACKED_SHOWS`，内容必须是一份 JSON 数组：

```yaml
TRACKED_SHOWS: >-
  [{"name":"Severance","id":"44934"},{"name":"The Last of Us","id":""}]
```

每一项支持：

| 字段 | 必填条件 | 说明 |
| --- | --- | --- |
| `id` | `name` 为空时必填 | TVmaze Show ID；填写后直接查询该 ID。 |
| `name` | `id` 为空时必填 | 仅用于搜索 TVmaze ID，建议使用 TVmaze 可识别的原始剧名。 |

Widget 显示的剧名始终来自 TVmaze 返回的 `show.name`。配置中的 `name` 不是显示别名；成功取得数据后不会用它覆盖官方剧名。

如果没有填写 ID，首次运行会搜索名称、选择名称完全匹配的结果；没有完全匹配时使用相关度最高的第一项。解析出的 ID 会长期缓存。存在同名剧集时，建议直接填写 TVmaze ID 以避免歧义。

TVmaze ID 可以从剧集页面地址中取得。例如：

```text
https://www.tvmaze.com/shows/44934/severance
                             ^^^^^
```

## 分页

一份 `TRACKED_SHOWS` 可以供不同尺寸或多个 Widget 共用：

```yaml
PAGE: '1'
```

- 中号第 1 页显示第 1–3 项，第 2 页显示第 4–6 项。
- 大号第 1 页显示第 1–7 项，第 2 页显示第 8–14 项。
- 标题右侧会显示当前页码和总页数，例如 `2/3`。
- 若要同时展示多个页面，可以在模块中复制 `widgets` 条目并为它们设置不同的 `name` 和 `PAGE`；各页面仍会共用同一份逐剧缓存。

示例：

```yaml
widgets:
- name: 剧集追踪 · 第 1 页
  script_name: episode-tracker
  env:
    TRACKED_SHOWS: '[{"name":"Severance","id":""},{"name":"Silo","id":""},{"name":"The Last of Us","id":""},{"name":"Fallout","id":""}]'
    PAGE: '1'
    REFRESH_HOURS: '24'
    REQUEST_TIMEOUT_SECONDS: '10'
- name: 剧集追踪 · 第 2 页
  script_name: episode-tracker
  env:
    TRACKED_SHOWS: '[{"name":"Severance","id":""},{"name":"Silo","id":""},{"name":"The Last of Us","id":""},{"name":"Fallout","id":""}]'
    PAGE: '2'
    REFRESH_HOURS: '24'
    REQUEST_TIMEOUT_SECONDS: '10'
```

两个条目必须使用同一份 `TRACKED_SHOWS`。第二页需要配置超过当前尺寸单页容量的剧集，否则会显示页码范围提示。

## 状态规则

- 最近已播集使用 TVmaze 的 `previousepisode`。
- 下一集使用 TVmaze 的 `nextepisode`。
- 标准集数显示为 `S02E08`；缺少标准季/集编号时显示为“特别篇”。
- 下一集有 `airstamp` 时转换为设备本地时间。
- 下一集存在但日期未知时显示“待公布”。
- 已完结且没有下一集时显示“已完结”。
- 其他没有下一集资料的状态显示“待定”。

## 缓存和异常处理

- 每一部剧单独缓存，成功数据 24 小时内不会再次请求。
- 添加一部新剧只会请求新增条目，不会让其他有效缓存失效。
- 请求失败时优先显示最近一次成功结果，并在对应行标记“缓存”。
- 单部剧获取失败只影响该行。
- 空配置不会发起任何网络请求。
- `refreshAfter` 是建议给 iOS 的最早刷新时间，实际刷新可能晚于 24 小时。

TVmaze 公共 API 有调用频率限制。Widget 每页最多处理 7 部剧，并通过每日缓存减少请求。数据依据 TVmaze 的 CC BY-SA 条款使用，Widget 保留 `Data: TVmaze` 署名以及 TVmaze 链接。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TRACKED_SHOWS` | `[]` | 跟踪剧集 JSON。 |
| `PAGE` | `1` | 当前页码，从 1 开始。 |
| `REFRESH_HOURS` | `24` | 成功数据缓存和刷新间隔。 |
| `REQUEST_TIMEOUT_SECONDS` | `10` | 单次 TVmaze 请求超时。 |

## 文件

- `episode-tracker.js`：Egern Generic Widget 脚本。
- `episode-tracker.yaml`：可直接安装的 Egern 模块。
- `episode-tracker.test.mjs`：不依赖第三方包的 Node.js 行为测试。

运行测试：

```shell
node --test egern/widget/episode_tracker/episode-tracker.test.mjs
```
