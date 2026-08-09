# 豆瓣口碑榜 Widget

一个 Egern 通用脚本提供两个独立 Widget：

- 豆瓣国外综艺榜（`show_global_best_weekly`）
- 豆瓣全球剧集榜（`tv_global_best_weekly`）

两个 Widget 使用相同的布局、缓存和异常处理逻辑。需要快速切换时，可以把两个同尺寸 Widget 放入 iOS 智能叠放，通过上下滑动切换。

## 安装

在 Egern 中打开“工具 → 模块 → +”，添加以下模块地址：

```text
https://raw.githubusercontent.com/ZLam/VPN/refs/heads/main/egern/widget/douban_ranking/douban-ranking.yaml
```

启用模块后，进入“分析 → Widget Gallery”，可以看到“豆瓣国外综艺榜”和“豆瓣全球剧集榜”。将所需尺寸添加到主屏幕或锁屏即可。

## 工作方式

脚本请求豆瓣移动端榜单接口：

```text
https://m.douban.com/rexxar/api/v2/subject_collection/{COLLECTION_ID}/items?playable=0&start=0&count=10
```

- 成功数据按榜单分别缓存。
- 成功刷新后的 24 小时内直接使用缓存，避免重复请求。
- 24 小时后再次运行时请求最新数据。
- 请求失败时保留并显示最近一次成功结果，同时在标题处标记“缓存”。
- 榜首海报单独缓存；图片失败时使用 SF Symbol 占位。
- `refreshAfter` 是向 iOS 提交的最早刷新时间，实际刷新可能晚于 24 小时。

## 尺寸

- 小号：榜首海报与前三名。
- 中号：榜首海报与前五名。
- 大号及超大号：榜首详情与前八名。
- 锁屏矩形：前两名。
- 锁屏圆形：榜首评分。
- 锁屏行内：榜首标题与评分。

点击榜单条目会使用豆瓣提供的跳转链接，点击标题或空白区域会打开完整榜单。

## 配置

模块已为两个 Widget 写入默认环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COLLECTION_ID` | 按 Widget 设置 | 仅支持两个内置榜单 ID |
| `REFRESH_HOURS` | `24` | 成功数据的缓存和请求刷新间隔 |
| `REQUEST_TIMEOUT_SECONDS` | `10` | 榜单及海报请求超时 |

## 文件

- `douban-ranking.js`：Egern Generic Widget 脚本。
- `douban-ranking.yaml`：可直接安装的 Egern 模块。
- `douban-ranking.test.mjs`：不依赖第三方包的 Node.js 行为测试。
