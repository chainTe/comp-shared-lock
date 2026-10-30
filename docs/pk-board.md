# PK 留言板（草案）

一个频道，两个阵营，各说各的。

## 概念

- 一个频道：`name = "…vs…"`，`channel_hash` 按名字算（不变）
- 两个 cell：A 方一个、B 方一个；各自 data 里的 `sponsor` 写自己的阵营名
- 用户用哪边的 cell 发，就算哪边得分

## 链上模型

沿用 COMP Shared Lock，不改合约。

| 对象 | 内容 |
| --- | --- |
| 频道 | `args = channel_hash ‖ max_fee`，两边相同 |
| A cell | data = comp-meta v2（name, kind=chat, sponsor="A 队"） |
| B cell | data = comp-meta v2（name, kind=chat, sponsor="B 队"） |

两个 cell 互不干扰：各自满足"一个输入、一个后继、data 不变"，天然两条并行通道。

## 留言 payload

`extensions` 里放：

```json
{ "pk": 1, "side": "A", "text": "加油！" }
```

`side` 是 `A`/`B`，必须和发出它的 cell 阵营一致；匿名或签名都行。

## 展示

就两块：左 A、右 B，各自一条留言流，最新在前。

每条显示阵营色、时间、是否署名；新留言高亮一下。不做计分、不做排行榜。

## 限制

- 一个 cell 一个区块只能过一笔，两边各自排队
- 消息删不掉，刷屏只能前端过滤
- "A 队" cell 谁都能建，前端以创建时登记的那个为准

## 开放问题

- 要不要给两边各加一个"最近活跃"标记
- 刷屏怎么过滤（先交给前端白名单）
