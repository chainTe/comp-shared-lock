# COMP Wall — 链上共创涂鸦板设计文档

# 1. 项目概述

COMP Wall 是基于 **COMP Shared Lock** 构建的链上公共共创涂鸦板。

核心理念：

> **Everyone can draw. History stays.**

任何人都可以进入一面公共 Wall，在画布上绘画、写字或添加简单图形。用户可以匿名参与，也可以使用签名身份参与。

与普通在线白板不同，COMP Wall 将每次作品提交表示为一次 COMP Shared Cell 状态迁移，因此可以保留可验证的创作历史，并通过 Time Machine 回放整面墙从空白到当前状态的演化过程。

核心体验：

**打开网页 → 选择 Wall → 创作 → Post → 上链。**

匿名创作不要求用户先连接钱包或持有 CKB；Shared Cell 可以承担允许范围内的交易费用。

---

# 2. 产品定位

COMP Wall 不定位为专业绘画软件，而是：

> **一个所有人共同创造、共同修改，并由区块链保存历史的公共数字空间。**

它强调四个特点：

### Permissionless

任何人都可以参与创作。

### Collaborative

所有人看到并修改的是同一个公共空间。

### Sponsored

Wall 可以预先获得 CKB Capacity，由 Shared Cell 为用户承担允许范围内的交易费用。

### Verifiable History

当前画面可以不断变化，但历史创作记录可以通过链上 transaction history 重建。

---

# 3. COMP 与 Wall 的关系

每一面 Wall 对应一个 COMP Shared Cell。

例如：

```text
#ckb-wall
#fiber
#bitcoin
#anonymous
#art
```

使用：

```text
args.hash = hash(channel_name)
```

区分不同 Wall。

整体结构：

```text
COMP Protocol
     │
     ├── COMP Cell: #ckb-wall
     │       └── Graffiti Events
     │
     ├── COMP Cell: #fiber
     │       └── Graffiti Events
     │
     └── COMP Cell: #art
             └── Graffiti Events
```

前端扫描 COMP Cells，根据 `args.hash` 分组并发现不同 Wall。

Wall 名称等 metadata 可以存储在 Cell data 中，后续也可以升级为独立 Registry 机制。

---

# 4. 核心交互模型

一次用户创作过程：

```text
进入 Wall
   ↓
读取当前画布
   ↓
本地绘画
   ↓
点击 Post
   ↓
序列化 Graffiti Event
   ↓
构造 COMP Transaction
   ↓
提交交易
   ↓
Pending / Wet Paint
   ↓
交易确认
   ↓
On-chain / Dry
```

重要原则：

**绘画过程不上链，作品提交才上链。**

例如用户连续画了 100 个 mouse move point：

```text
mousedown
mousemove
mousemove
mousemove
...
mouseup
```

前端将其组合成一个：

```text
Stroke
```

而不是产生 100 笔交易。

---

# 5. Graffiti Event Model

不要在每次交易中保存整张 Canvas。

采用 **Event Model**。

每次 COMP transition 保存一次创作事件。

## 5.1 Stroke

```json
{
  "version": 1,
  "type": "stroke",
  "points": [
    [120, 80],
    [122, 82],
    [126, 86],
    [130, 90]
  ],
  "color": "#7861FF",
  "width": 8
}
```

前端按照顺序 Replay Stroke。

---

# 6. 支持的 Event 类型

第一版建议只支持：

```text
stroke
text
shape
erase
```

## Stroke

自由绘画。

```json
{
  "type": "stroke",
  "points": [],
  "color": "#FF4D4F",
  "width": 8
}
```

## Text

```json
{
  "type": "text",
  "x": 320,
  "y": 180,
  "text": "GM CKB!",
  "color": "#111111",
  "size": 32
}
```

## Shape

用于简单图形：

```text
circle
rectangle
line
arrow
```

例如：

```json
{
  "type": "shape",
  "shape": "circle",
  "x": 300,
  "y": 200,
  "radius": 50,
  "color": "#FFB020"
}
```

## Erase

Erase 本质上也是 Event。

可以记录：

```json
{
  "type": "erase",
  "points": [],
  "width": 24
}
```

因此被擦掉的内容虽然从当前 Canvas 消失，但仍然可以通过历史 Replay 找回来。

---

# 7. Batch Event

一次 Post 可以包含多个操作：

```json
{
  "version": 1,
  "type": "batch",
  "events": [
    {
      "type": "stroke"
    },
    {
      "type": "stroke"
    },
    {
      "type": "text"
    }
  ]
}
```

这样用户可以在本地画一段时间，然后一次性：

**Post to Wall**

减少链上 transaction 数量。

需要设置限制，例如：

```text
max events / post
max points / stroke
max serialized size
```

防止单次 Graffiti Event 过大。

---

# 8. Canvas

Canvas 是整个产品最重要的区域。

建议占据桌面端页面：

```text
70% ~ 85%
```

视觉原则：

> **UI 应该退到背景，用户作品才是主角。**

Canvas 初始可以采用：

```text
浅灰白墙面
+
非常轻微的砖墙/纸张纹理
```

不要使用完全纯白背景，也不要加入过重纹理。

随着用户参与：

```text
Empty Wall
   ↓
Few Marks
   ↓
Community Art
   ↓
Chaotic Public Wall
```

Wall 自身逐渐成为产品最主要的视觉元素。

---

# 9. 页面布局

桌面版：

```text
┌─────────────────────────────────────────────────────────┐
│ COMP WALL     #ckb-wall       ● LIVE       ♥ Sponsor   │
├───────────┬───────────────────────────────┬─────────────┤
│           │                               │             │
│   Walls   │                               │  Activity   │
│           │                               │             │
│ #ckb      │          CANVAS               │ Anonymous   │
│ #fiber    │                               │ Alice       │
│ #bitcoin  │                               │ Bob         │
│ #art      │                               │ Anonymous   │
│           │                               │             │
│           │     Floating Toolbar          │             │
├───────────┴───────────────────────────────┴─────────────┤
│                     TIME MACHINE                        │
└─────────────────────────────────────────────────────────┘
```

Canvas 必须始终拥有最大的视觉权重。

---

# 10. 顶部导航

顶部只展示用户真正需要的信息：

```text
COMP WALL

#ckb-wall

● LIVE

1,283 marks

Explore

History

♥ Sponsor
```

不要默认展示：

```text
code_hash
args
tx hash
capacity
block number
```

这些信息应该进入高级详情页面。

目标是：

> 用户先使用产品，再逐渐发现这是一个 CKB 应用。

---

# 11. Wall Explorer

左侧展示所有发现的 Wall。

例如：

```text
WALLS

┌─────────────────┐
│ [thumbnail]     │
│ #ckb-wall       │
│ 1,283 marks     │
└─────────────────┘

┌─────────────────┐
│ [thumbnail]     │
│ #fiber          │
│ 628 marks       │
└─────────────────┘

┌─────────────────┐
│ [thumbnail]     │
│ #bitcoin        │
│ 932 marks       │
└─────────────────┘
```

Thumbnail 直接使用当前 Wall 的缩略图。

因此 Wall Explorer 本身也会随着社区创作持续变化。

---

# 12. Create Wall

用户连接钱包后可以创建新的 Wall。

流程：

```text
Create Wall
     ↓
输入名称
     ↓
生成

hash(channel_name)
     ↓
设置初始 Capacity
     ↓
创建 COMP Shared Cell
     ↓
Wall 上线
```

UI：

```text
Create a Wall

Name
[ CKB Summit 2026 ]

Wall ID
0x3bf471...

Initial Paint Supply

[ 100 CKB ]

Estimated posts

~10,000

[ Create Wall ]
```

---

# 13. Drawing Toolbar

Toolbar 使用 Floating Design。

位于 Canvas 底部中央：

```text
╭────────────────────────────────────────────╮
│ ✏  ◇  T  ☺  ▱ │ ● ● ● ● ● │ ━━━ │ POST │
╰────────────────────────────────────────────╯
```

第一版工具：

```text
Pen
Eraser
Text
Shape
Undo
Color
Brush Size
Post
```

其中：

**Undo 只撤销尚未 Post 的本地操作。**

已经上链的 Event 不应该通过普通 Undo 从历史中删除。

---

# 14. Draft 状态

用户绘画时，所有内容首先处于：

```text
Local Draft
```

例如：

```text
On-chain Canvas
      +
Local Draft Layer
```

技术上建议分层：

```text
Layer 1
Confirmed Events

Layer 2
Pending Events

Layer 3
Local Draft
```

这样可以非常清楚地区分不同状态。

---

# 15. Wet Paint

点击 Post 后：

```text
Local Draft
     ↓
Transaction submitted
     ↓
Pending
```

不要使用传统 Web3：

```text
Transaction Pending...
```

而使用产品化表达：

```text
Wet Paint...
```

视觉表现：

```text
opacity: 70%
+
轻微动画
```

例如：

```text
CKB ♥

Wet paint...
```

---

# 16. On-chain / Dry

交易进入区块后：

```text
Wet Paint
     ↓
Confirmed
     ↓
On-chain
```

UI 短暂显示：

```text
✓ On-chain
```

随后恢复正常显示。

形成：

```text
Draft
  ↓
Wet Paint
  ↓
On-chain
```

非常符合 Graffiti 的产品语言。

---

# 17. Tx Pool 实时显示

客户端可以尝试读取 tx pool 中尚未确认的 COMP Cell transition。

因此：

```text
Confirmed Cell
      +
Tx Pool Cell
      +
Local Draft
```

可以共同组成用户当前看到的 Canvas。

这样用户提交之后，不需要等待区块确认才看到作品。

同时其他用户也可以较快看到：

```text
Wet Paint
```

从而产生接近实时公共画板的体验。

---

# 18. Activity Feed

右侧显示最近发生的创作。

例如：

```text
ACTIVITY

👻 Anonymous
draw a heart
just now

02bd...31af
write "Fiber"
1 min ago

👻 Anonymous
draw a cat
2 mins ago

03af...91cd
draw a tree
3 mins ago
```

点击 Activity：

```text
Canvas 自动定位对应作品
+
Highlight
```

---

# 19. Graffiti Detail

用户点击某一笔作品时显示浮层：

```text
╭─────────────────────────╮
│ 👻 Anonymous            │
│ 3 mins ago              │
│                         │
│ Block   18,293,102      │
│ Tx      0x8f3e...a7c1   │
│                         │
│ View on CKB Explorer ↗  │
╰─────────────────────────╯
```

签名用户：

```text
02bd...31af

✓ Signed
```

这样用户能够理解：

> 每一笔作品背后都有一个可验证的链上来源。

---

# 20. Identity

支持三种体验层级。

## Anonymous

默认。

```text
👻 Anonymous
```

不要求钱包。

---

## Signed Identity

浏览器生成或导入 secp256k1 identity。

```text
02bd61...92af

✓ Signed
```

签名按照 COMP Shared Lock 当前定义的 message signing 机制完成。

---

## Wallet

可选。

用于：

```text
Create Wall
Sponsor Wall
```

不应该强制普通绘画用户连接钱包。

---

# 21. Sponsor / Paint Supply

不要把 Shared Cell Capacity 直接作为主要产品语言。

使用：

> **Paint Supply**

例如：

```text
PAINT SUPPLY

████████████████░░░

82%

82 CKB remaining

♥ Sponsor
```

对应关系：

```text
Paint Supply
      ↓
COMP Shared Cell Capacity
      ↓
Network Fee
```

产品文案：

> Keep the wall alive.

> Buy paint for everyone.

用户 Sponsor：

```text
10 CKB
50 CKB
100 CKB
Custom
```

本质上向 COMP Shared Cell 增加 Capacity。

---

# 22. Time Machine

Time Machine 是 COMP Wall 最重要的差异化功能之一。

底部：

```text
TIME MACHINE

▶ ─────●────────●────────●────────●─────

   Day 1      Day 3     Day 15     Now

 Empty      First      Castle     1,283
 Wall       Doodles               marks
```

拖动时间：

```text
Now
 ↓
Block N
 ↓
Replay events <= N
 ↓
历史 Canvas
```

因此用户可以查看：

```text
昨天的 Wall
一周前的 Wall
第 100 次创作
某个区块高度的 Wall
```

---

# 23. Replay Wall

Time Machine 支持播放：

```text
▶ Replay Wall
```

播放速度：

```text
1x
4x
16x
64x
```

效果：

```text
Empty Wall
   ↓
First Stroke
   ↓
First Text
   ↓
More Graffiti
   ↓
Community Art
   ↓
Current Wall
```

这可以成为非常适合分享的视频化体验。

---

# 24. 共创机制

COMP Wall 不应该强调：

```text
我的画
你的画
```

而应该强调：

```text
我们的 Wall
```

因此第一版允许：

```text
覆盖
擦除
重新绘制
添加内容
```

即：

> 当前状态属于所有参与者共同创造。

即使作品后来被覆盖，原始 Event 仍存在历史中，可以通过 Time Machine 查看。

---

# 25. 可扩展：Pixel Mode

后续可以加入：

```text
Pixel Wall
```

类似公共 Pixel Art。

例如：

```text
256 × 256
512 × 512
1024 × 1024
```

用户一次提交一个区域：

```text
8 × 8
16 × 16
32 × 32
```

而不是一个 Pixel 一笔交易。

可以形成社区之间的：

```text
Pixel War
```

---

# 26. 可扩展：Sticker

后续允许社区定义 Sticker：

```text
CKB
Fiber
Bitcoin
Heart
Rocket
Tree
Cat
```

Event：

```json
{
  "type": "sticker",
  "id": "ckb-logo",
  "x": 320,
  "y": 180,
  "scale": 1.2,
  "rotation": 10
}
```

这样手机用户也可以很方便参与。

---

# 27. 可扩展：Infinite Canvas

第一版建议：

```text
固定 Canvas
```

例如：

```text
1920 × 1080
```

或者：

```text
2048 × 2048
```

第二阶段再升级：

```text
Infinite Canvas
```

通过：

```text
pan
zoom
tile
```

浏览不同区域。

数据按 Tile 分区：

```text
Tile(0,0)
Tile(0,1)
Tile(1,0)
Tile(1,1)
```

避免每次重建整个无限画布。

---

# 28. 前端架构

建议：

```text
Frontend
│
├── Wall Discovery
│
├── Canvas Engine
│
├── Event Store
│
├── COMP Client
│
├── Tx Pool Tracker
│
├── Identity
│
├── Time Machine
│
└── Local Cache
```

Canvas Engine 可以选择：

```text
Fabric.js
Konva
PixiJS
```

第一版 Fabric.js / Konva 都足够。

如果未来大量对象和无限 Canvas，可以考虑 PixiJS。

---

# 29. Event Store

前端内部统一维护：

```text
events[]
```

例如：

```text
EventStore

#100 stroke
#101 stroke
#102 text
#103 erase
#104 shape
...
```

Canvas 不直接依赖 CKB RPC。

数据流：

```text
CKB
 ↓
COMP Parser
 ↓
Graffiti Event
 ↓
Event Store
 ↓
Canvas Renderer
```

这样未来即使修改链上 encoding，也不会严重影响 Canvas UI。

---

# 30. 本地缓存

当前项目已经具有浏览器缓存能力，可以继续扩展。

建议 IndexedDB 保存：

```text
Wall Metadata

Confirmed Events

Last Scanned Block

Canvas Snapshot

Pending Transactions
```

打开 Wall：

```text
IndexedDB
   ↓
立即显示缓存 Canvas
   ↓
后台获取最新 transition
   ↓
增量更新
```

避免每次打开页面重新扫描完整历史。

---

# 31. Snapshot

随着 Wall Event 增加：

```text
10
100
1,000
100,000
```

从 genesis replay 所有 event 会越来越慢。

因此客户端可以生成：

```text
Snapshot @ Block N
```

保存：

```text
Rendered Canvas
+
Last Event
+
Block Number
```

下次：

```text
Snapshot
  ↓
校验 checkpoint
  ↓
Replay events after Block N
  ↓
Current Canvas
```

Snapshot 只是一种客户端加速结果，不是新的链上事实来源。任意客户端都必须能够丢弃 Snapshot，并从链上 Event 重新得到相同画面。

建议保存：

```json
{
  "version": 1,
  "wall_hash": "0x...",
  "canvas": {
    "width": 1920,
    "height": 1080
  },
  "checkpoint": {
    "block_number": "18293102",
    "block_hash": "0x...",
    "event_id": "0x...:0:2"
  },
  "image_key": "snapshot:0x...:18293102",
  "created_at": 1787300000000
}
```

Snapshot 失效条件：

```text
Wall hash 不匹配
协议版本不支持
Canvas 尺寸不匹配
checkpoint block hash 发生变化
本地 Event 索引不连续
Snapshot 解码或校验失败
```

发生失效时，客户端自动回退到最近一个可信 Snapshot，或从 genesis 重新 Replay。

---

# 32. Canvas 坐标系统

第一版使用固定逻辑画布：

```text
1920 × 1080
```

浏览器根据可见区域缩放显示，但所有 Event 均使用逻辑坐标，不保存屏幕像素坐标。

```text
screen point
    ↓ inverse viewport transform
logical point
    ↓ clamp / simplify
Graffiti Event
```

坐标规则：

```text
x: 0 <= x <= 1920
y: 0 <= y <= 1080
width: 1 <= width <= 96
rotation: -180 <= rotation <= 180
```

Stroke 的点在序列化前执行简化，避免设备采样率不同导致同一笔画产生数量差异过大的 points。

推荐：

```text
采样最短距离       2 logical px
Ramer-Douglas-Peucker epsilon  1.5 logical px
坐标精度           0.1 logical px
```

缩放、平移只改变 Viewport，不改变已经保存的 Event。

---

# 33. 链上编码

COMP Wall 第一版复用 COMP Shared Lock v0.3 的现有消息格式，不要求修改 Lock Script。

COMP Lock args 实际结构为：

```text
Args {
  hash: Byte32,
  max_fee: u64 little-endian
}
```

其中：

```text
hash = hash(channel_name)
```

与当前前端保持一致的规范化过程：

```text
display name
  ↓ Unicode NFKC + trim
lowercase slug
  ↓ remove apostrophes, replace non-letter/number runs with "-"
preimage = "comp-channel-" + slug
  ↓ CKB blake2b-256
args.hash
```

Wall metadata 继续使用现有 Cell data：

```json
{
  "protocol": "comp",
  "version": 1,
  "type": "channel",
  "name": "CKB Wall",
  "slug": "ckb-wall"
}
```

Wall Event 放在 COMP message 的 `extensions.payload` 字符串中：

```json
{
  "public_key": null,
  "signature": null,
  "extensions": {
    "protocol": "comp",
    "version": 2,
    "type": "text",
    "payload": "{\"protocol\":\"comp-wall\",\"version\":1,...}"
  }
}
```

外层格式由 COMP Shared Lock 解析和验证；内层 `payload` 由 COMP Wall 客户端解析。

使用字符串封装的原因：

```text
兼容当前 COMP message schema
不改变现有签名算法
旧版 COMP 客户端仍可把它显示为普通消息
Wall 客户端可独立演进 Event schema
```

内层 canonical payload：

```json
{
  "protocol": "comp-wall",
  "version": 1,
  "type": "batch",
  "canvas": [1920, 1080],
  "events": [
    {
      "type": "stroke",
      "points": [[120, 80], [122, 82]],
      "color": "#7861FF",
      "width": 8
    }
  ]
}
```

序列化规则：

```text
UTF-8
JSON
字段名固定
不依赖字段顺序进行解析
数字必须是有限值
拒绝未知 protocol
按 version 选择解析器
```

第一版写入端即使只包含一个操作，也统一生成 `type: "batch"`；读取端可以兼容第 5 节所示的单 Event payload。签名与校验使用实际序列化字节，不对已经上链的 JSON 做重新格式化。

签名身份继续使用 COMP v0.2/v0.3 的签名摘要：

```text
message_hash   = blake2b_256([0u8; 65] || utf8(extensions_json))
signing_digest = blake2b_256(tx_hash || message_hash)
```

因此签名同时绑定：

```text
Transaction
Wall Event payload
Author public key
```

---

# 34. Event 校验与限制

链上 Lock Script 只保证 COMP Cell 的状态迁移和可选签名有效；Wall Event 的语义限制由客户端协议执行。

第一版建议限制：

```text
max events / post          64
max points / stroke        2,048
max text length            280 Unicode code points
max serialized payload     32 KiB
max brush width            96
max shapes / batch         64
max coordinates            Canvas bounds
```

客户端处理任何历史 Event 时必须：

```text
先检查 payload byte length
再解析 JSON
校验 protocol 和 version
逐字段校验类型和范围
限制数组长度与嵌套深度
拒绝 NaN / Infinity / 非法颜色
跳过单个坏 Event，不中断整面 Wall
记录 invalid event reason
```

颜色第一版只接受：

```text
#RRGGBB
```

Text 按纯文本渲染，不解释 HTML、Markdown、SVG 或 URL。

对于未知 Event 类型：

```text
Old Client
   ↓
Skip Unknown Event
   ↓
Continue Replay
```

这样新版本加入 Sticker 等类型时，不会破坏旧客户端对其余历史的重建。

---

# 35. Transaction 与状态迁移

一次 Post 对应一次 COMP Shared Cell transition：

```text
Input
  COMP Cell @ previous out point

Output
  same COMP lock
  same args.hash
  same args.max_fee
  no type script
  capacity reduced by fee, or increased by sponsor

Witness
  anonymous or signed COMP message
  payload = COMP Wall Event batch
```

必须满足现有 COMP Shared Lock 规则：

```text
每个 lock group 只有一个 input
只有一个 successor output
禁止 fork / merge
Lock 与 args 不变
相对 since = 1 block
fee <= max_fee
```

Cell data 第一版只保留 Wall metadata，不在每次 Post 中复制当前画布。

一面 Wall 可以具有多个相同 `args.hash` 的 COMP Cells，作为并行提交 lane：

```text
Wall #ckb
  ├── Cell lane A
  ├── Cell lane B
  ├── Cell lane C
  └── Cell lane D
```

客户端 Post 时选择当前可用且 Capacity 充足的 lane。这样多个用户不必始终竞争同一个 out point。

---

# 36. 并发、冲突与确定性顺序

同一个 COMP Cell 的两个未确认交易会产生 input conflict。

客户端策略：

```text
选择可用 Cell lane
    ↓
构造 Transaction
    ↓
提交
    ↓
如果 input conflict
    ↓
刷新 live cells
    ↓
选择新的 lane
    ↓
重建并重新签名
```

禁止直接复用旧签名，因为新 Transaction hash 已改变。

多 lane 的 Event 必须有确定性总顺序。建议按以下 tuple 排序：

```text
(
  block_number,
  transaction_index_in_block,
  comp_input_index,
  event_index_in_batch
)
```

唯一 Event ID：

```text
event_id = tx_hash : comp_input_index : event_index
```

Pending 阶段没有最终 block order，因此只用于即时预览：

```text
Confirmed Canvas
  + Pending overlay ordered by local seen_at
  + Local Draft
```

交易确认后必须使用最终链上顺序重新渲染。画面因此可能从 Wet Paint 预览产生一次轻微重排，这是公共并发画布的正常行为。

CKB reorg 处理：

```text
记录 block hash
检测 checkpoint 是否仍在主链
回滚受影响的 confirmed events
恢复为 pending 或 orphaned
按新主链重新 Replay
```

UI 对 1 个确认显示 `On-chain`，在高级详情中可以展示确认数；分享与导出建议等待更多确认。

---

# 37. Wall Discovery 与历史索引

Wall Discovery 扫描 COMP Lock prefix，并解析：

```text
code_hash
hash_type
args.hash
args.max_fee
Cell data metadata
capacity
out point
```

按 `args.hash` 聚合所有 live COMP Cells：

```text
Map<WallHash, Wall>
```

历史来源：

```text
CKB Indexer
   ↓ find transactions by lock
Transactions
   ↓ decode witness
COMP messages
   ↓ parse comp-wall payload
Graffiti Events
```

索引器必须去重同一 Transaction 中的 input/output 记录，并为多 lane 结果应用第 36 节的确定性排序。

增量扫描游标保存：

```json
{
  "wall_hash": "0x...",
  "last_scanned_block": "18293102",
  "last_scanned_block_hash": "0x...",
  "last_event_id": "0x...:0:2"
}
```

第一版使用浏览器直连 CKB RPC / Indexer。事件量增长后可增加可替换的只读索引服务，但客户端仍应提供链上验证路径。

---

# 38. Activity Feed 语义

Activity 不依赖图像识别。文案由 Event 类型确定：

```text
stroke      drew a stroke
text        wrote “...”
shape       added a circle
erase       erased an area
batch       added 5 marks
```

作者展示：

```text
public_key == null   → 👻 Anonymous
public_key present   → 02bd…31af · ✓ Signed
```

时间展示优先级：

```text
Pending       just now · Wet Paint
Confirmed     block timestamp
Unavailable   block #N
```

点击 Activity 时：

```text
计算 Event bounding box
移动 Viewport
绘制 1.2 秒 highlight ring
打开 Graffiti Detail
```

如果 Event 已被后来内容覆盖，Detail 中提供：

```text
View when posted
```

它会临时把 Time Machine 移动到该 Event 刚确认后的状态。

---

# 39. Paint Supply 计算

Paint Supply 来自 Wall 所有 live COMP Cells 的可用 Capacity。

```text
total_capacity = sum(live_cell.capacity)
reserved_capacity = sum(minimum_occupied_capacity)
usable_capacity = max(total_capacity - reserved_capacity, 0)
```

预计可提交次数：

```text
estimated_posts = usable_capacity / estimated_fee_per_post
```

进度百分比需要一个明确基准。第一版使用最近一次 Sponsor 后记录的本地高水位：

```text
paint_percent = usable_capacity / max(usable_capacity_high_watermark, usable_capacity)
```

如果没有高水位，不显示误导性的百分比，只显示：

```text
82 CKB available
~8,200 posts
```

状态阈值：

```text
> 30%    Plenty of paint
10–30%   Running low
< 10%    Almost dry
0        Wall needs paint
```

Sponsor 实际行为是通过钱包创建新的 COMP Cell lane，或增加合约允许的共享 Capacity。成功后重新扫描 live cells，并更新 Paint Supply。

---

# 40. Time Machine 行为规范

Time Machine 的输入是已经确定性排序的 confirmed events。

支持三种定位方式：

```text
Event index
Block number
Timestamp
```

Slider 的内部值建议使用 Event index，标签再映射为时间或区块。这样即使两个区块之间时间间隔很长，拖动仍保持平滑。

拖动时：

```text
找到最近 Snapshot <= target
   ↓
从 Snapshot Replay 到 target
   ↓
显示 Historical Mode 标记
   ↓
暂停绘画和 Post
```

回到 `Now` 后恢复创作。

Replay 播放：

```text
1x    逐 Event 播放
4x    每帧合并少量 Event
16x   按时间窗口批量播放
64x   优先保证终态，允许跳帧
```

播放只改变本地视图，不发起链上交易。

导出功能后续可以基于相同 Replay Engine 生成：

```text
PNG snapshot
MP4 / WebM replay
Shareable historical URL
```

历史 URL 示例：

```text
/wall/0x.../history?event=1024
```

---

# 41. 本地状态机

每次本地创作批次具有明确状态：

```text
EMPTY
  ↓ draw
DRAFT
  ↓ post
SIGNING
  ↓ submitted
PENDING
  ↓ committed
CONFIRMED
```

失败分支：

```text
SIGNING  → DRAFT      user cancelled / signer error
PENDING  → DRAFT      rejected and safe to retry
PENDING  → ORPHANED   transaction disappeared / reorg
```

UI 规则：

```text
DRAFT       opacity 100%, dotted local outline
SIGNING     Post disabled, show “Preparing paint…”
PENDING     opacity 70%, subtle wet shimmer
CONFIRMED   opacity 100%, brief “✓ On-chain”
ORPHANED    keep local copy, show retry action
```

刷新页面后，Pending Transactions 从 IndexedDB 恢复并通过 tx hash 查询状态。

---

# 42. 错误、空状态与降级

产品必须对以下状态提供清晰反馈：

## Empty Wall

```text
This wall is waiting for its first mark.

[ Start drawing ]
```

## RPC unavailable

```text
Showing the last saved wall.
Chain updates are temporarily unavailable.

[ Retry ]
```

缓存可用时不清空 Canvas。

## No usable Cell

```text
The wall is out of paint.

[ Sponsor this wall ]
```

本地仍允许绘画和保存 Draft，但 Post 暂停。

## Transaction conflict

客户端自动换 lane 并重试有限次数；超过次数后恢复 Draft，并显示：

```text
The wall changed while you were posting.
Your draft is safe.

[ Try again ]
```

## Unsupported Event

跳过该 Event，在高级详情显示 `Unsupported event version`，其余画面继续渲染。

## Corrupt cache

删除对应 Wall 的缓存分区并从链上重建，不影响其他 Wall。

---

# 43. 安全与公共空间治理

COMP Wall 是 permissionless public space。协议层不能假设所有 Event 都友好。

必须防护：

```text
超大 payload
超长 points 数组
深层 JSON
非法数字
Canvas 越界
HTML / SVG 注入
恶意 Unicode
重复或畸形交易记录
Replay CPU / memory exhaustion
Snapshot cache poisoning
```

渲染器只调用受控 Canvas API，不把 Event 内容拼接到 `innerHTML`。

Text 使用纯文本和固定字体集合。外部图片、远程字体和任意 Sticker URL 第一版不支持。

客户端内容治理是本地视图层能力，不修改链上历史：

```text
Hide Event locally
Hide Author locally
Reset local filters
```

后续可加入社区共享 filter list，但必须明确：

```text
隐藏 ≠ 删除
过滤结果 ≠ 链上历史
```

签名只证明某个公钥签署了 Event，不自动代表真实姓名、信誉或平台认证。

私钥规则：

```text
浏览器身份私钥只保存在本地
不得写入日志或遥测
提供导出 / 导入前显示明确提醒
钱包密钥始终由钱包管理
```

---

# 44. 性能预算

第一版目标设备：近三年桌面浏览器与主流移动浏览器。

体验预算：

```text
缓存首屏 Canvas             < 500 ms
本地绘画输入到显示           < 16 ms p50
常规 Replay frame           < 16 ms p50
Activity 点击定位           < 300 ms
增量链上刷新不阻塞绘画       0 dropped interaction
```

建议优化顺序：

```text
1. Stroke point simplification
2. Offscreen confirmed layer
3. requestAnimationFrame batch render
4. Snapshot checkpoints
5. Web Worker event parsing
6. OffscreenCanvas / tile rendering
```

Canvas 分层能够避免每次 pointer move 重绘全部历史：

```text
Confirmed layer  只在新 confirmed event 或 Time Machine 改变时重绘
Pending layer    pending 集合改变时重绘
Draft layer      每帧只更新当前本地笔画
```

Event Store 不保留不受限的重复对象；Snapshot 与历史分段按 LRU 清理，并提供可配置的本地缓存上限。

---

# 45. 移动端与可访问性

移动端布局：

```text
Top Bar
Canvas
Bottom Floating Toolbar
Bottom Sheet: Walls / Activity / Time Machine
```

触摸规则：

```text
单指使用当前工具绘画
双指 pan / zoom
长按选中 Graffiti
工具按钮触控区域 >= 44 × 44 px
```

绘画时禁用浏览器页面滚动；进入导航模式后恢复手势滚动。

可访问性要求：

```text
所有工具有可读 label 与 keyboard shortcut
颜色选择显示名称和 hex，不只依赖颜色区分
状态同时使用文字、图标和动画
支持 prefers-reduced-motion
焦点顺序与视觉顺序一致
对比度达到 WCAG AA
Canvas 提供 Activity 列表作为语义替代
```

键盘快捷键：

```text
P       Pen
E       Eraser
T       Text
S       Shape
Cmd/Ctrl+Z  Undo local draft
Cmd/Ctrl+Enter  Post
Space   临时 Pan
```

---

# 46. 可观测性

第一版不收集绘画内容或身份私钥。

允许的匿名产品指标：

```text
wall_opened
draft_started
post_started
post_submitted
post_confirmed
post_failed(error_category)
time_machine_opened
replay_started(speed)
sponsor_opened
```

性能指标：

```text
cache_render_ms
chain_refresh_ms
event_parse_ms
replay_ms
pending_to_confirmed_ms
snapshot_hit_rate
invalid_event_count
```

不得发送：

```text
私钥
完整签名
未发布 Draft
Text 内容
完整 public key（可用不可逆聚合标识）
```

开发模式提供 Diagnostics Panel：

```text
RPC endpoint
last scanned block
confirmed / pending / invalid event counts
snapshot checkpoint
render time
cache size
```

这些信息默认不占用主界面。

---

# 47. 测试策略

## Event Codec 单元测试

```text
每种合法 Event encode / decode
Batch 顺序保持
未知字段兼容
未知 version 跳过
非法坐标拒绝
超长 points / text / payload 拒绝
Unicode Text 正确 round-trip
canonical examples 固定快照
```

## Renderer 单元测试

```text
相同 Event 序列得到相同像素 hash
Erase 顺序正确
Shape bounding box 正确
Historical target 不渲染未来 Event
坏 Event 不影响后续 Event
```

## Event Store 测试

```text
confirmed / pending / draft 分层
tx hash 去重
多 lane 确定性排序
pending 确认后的迁移
reorg 回滚
Snapshot checkpoint 恢复
```

## Transaction 集成测试

```text
匿名 Graffiti Post
签名 Graffiti Post
Batch Post
fee 超过 max_fee
Cell lane conflict 后重试
无可用 Capacity
Sponsor 后恢复
```

## UI 端到端测试

```text
打开缓存 Wall
绘制 Stroke
Undo 仅影响 Draft
Post → Wet Paint → On-chain
选择 Activity 并定位
Time Machine 拖动与回到 Now
Replay 速度切换
RPC 离线降级
移动端双指导航与工具栏
```

## 验证数据集

仓库保存一个固定 Event fixture：

```text
empty
mixed-tools-100
multi-lane-order
invalid-events
large-wall-10k
large-wall-100k
```

CI 至少执行：

```text
TypeScript typecheck
Event Codec tests
Renderer deterministic tests
Frontend production build
COMP contract tests
关键 Playwright flows
```

---

# 48. MVP 范围

第一版必须交付：

```text
✓ Wall Discovery
✓ 固定 1920 × 1080 Canvas
✓ Pen / Eraser / Text / Shape
✓ Color / Brush Size / Local Undo
✓ Batch Post
✓ Anonymous / Browser-key signed identity
✓ Draft / Wet Paint / On-chain 三层状态
✓ Activity Feed 与 Graffiti Detail
✓ Paint Supply 与 Sponsor 入口
✓ Time Machine 与 1x / 4x / 16x / 64x Replay
✓ IndexedDB 增量缓存
✓ Snapshot checkpoint
✓ 多 Cell lane 与 conflict retry
✓ 桌面与移动端响应式布局
```

第一版明确不包含：

```text
Infinite Canvas
任意图片上传
远程 Sticker
图层编辑器
复杂选区与对象变换
实时 WebSocket 协作服务器
链上 Snapshot 共识
Token 激励或 NFT 化
```

这些功能不应阻塞 MVP。

---

# 49. 实施阶段

## Phase 0 — Protocol Fixture

```text
定义 comp-wall v1 schema
实现 Codec 与校验器
建立 deterministic renderer fixtures
确认 COMP witness payload 与签名兼容
```

## Phase 1 — Local Canvas

```text
固定 Canvas
Pen / Eraser / Text / Shape
Draft Layer
Undo
Batch serialization
```

## Phase 2 — On-chain Wall

```text
Wall Discovery
读取并 Replay Graffiti Events
Anonymous / Signed Post
Pending tracker
Wet Paint / On-chain
multi-lane conflict retry
```

## Phase 3 — Community Experience

```text
Wall Explorer thumbnails
Activity Feed
Graffiti Detail
Paint Supply
Sponsor
mobile layout
```

## Phase 4 — History at Scale

```text
IndexedDB incremental index
Snapshot
Time Machine
Replay
reorg handling
large-wall performance tests
```

## Phase 5 — Extensions

```text
Pixel Mode
curated Sticker packs
Infinite Canvas / Tiles
shareable replay export
optional read-only index service
```

---

# 50. 产品指标

核心指标不是单纯的交易量，而是共同创作是否发生。

North Star：

```text
Weekly Walls with 3+ distinct participants
```

辅助指标：

```text
Wall open → first draft conversion
Draft → Post conversion
Anonymous post success rate
Median pending-to-confirmed time
Distinct signed identities / Wall
Marks / active Wall
Time Machine usage rate
Replay completion rate
Sponsor conversion
Paint runway
7-day returning creators
```

健康指标：

```text
invalid Event rate
transaction conflict rate
post retry success rate
RPC failure rate
cache corruption rate
reorg recovery success rate
P95 replay time
```

---

# 51. 已确定的产品决策

```text
画布模型          第一版固定 1920 × 1080
数据模型          Event Sourcing，不保存整张 Canvas
提交单位          一次 Post 一个 Batch
链上承载          COMP message extensions.payload JSON string
身份              Anonymous 默认，Signed 可选，Wallet 用于管理 Capacity
实时感知          Confirmed + Pending + Draft 分层
历史顺序          按链上 block / transaction / input / batch 顺序
并发扩展          同一 Wall 多 COMP Cell lanes
历史加速          本地 Snapshot，链上历史仍为 canonical source
删除语义          Erase 是新 Event，不删除历史
治理语义          本地隐藏，不篡改链上记录
```

---

# 52. 待验证问题

以下问题不阻塞 Protocol Fixture，但必须在对应 Phase 开始前验证：

```text
1. 32 KiB payload 在目标 max_fee 下的实际 fee 与 cycle 成本
2. Public RPC 对多 lane 历史扫描的延迟与限流表现
3. tx pool API 在浏览器直连环境中的可用性
4. 100k Events 的 Snapshot 间隔与存储上限
5. 移动端 Canvas 文字输入和双指手势冲突
6. Sponsor 创建新 lane 与增加现有 lane 的最佳钱包交互
7. 历史分享 URL 使用 event index、block number 或 event_id 的稳定性
8. 内容过滤列表的来源、签名与更新机制
```

每个问题的决策都应记录：

```text
假设
测量方法
测试环境
结果
决策
回滚条件
```

---

# 53. MVP 验收标准

一个 MVP 可以宣布完成，必须同时满足：

## 创作

```text
用户打开任意存在的 Wall 后可以在缓存或链上画面上立即创作
四种 Event 均能本地预览并正确 Replay
Undo 不影响已经确认的 Event
Batch 超限时在提交前得到明确提示
```

## 上链

```text
匿名用户无需钱包即可完成一次 Post
签名用户的公钥与 Event payload 可由链上数据验证
成功提交后立即显示 Wet Paint
确认后自动转为 On-chain，刷新页面仍可恢复
input conflict 不会丢失 Draft
```

## 历史

```text
两个独立客户端对同一 Event 历史得到一致 Canvas
Time Machine 能定位任意已加载 Event
Replay 可以从空白播放到当前状态
被覆盖或擦除的内容仍能在历史中查看
```

## Capacity

```text
Paint Supply 与 live Cell Capacity 一致
无可用 Capacity 时禁止提交但保留 Draft
Sponsor 成功后 Wall 可继续 Post
```

## 可靠性

```text
RPC 离线时显示最后缓存的 Wall
坏 Event 不会阻塞其余历史
Snapshot 删除后可以从链上重建同一终态
reorg fixture 能正确回滚并重放
```

## 质量门槛

```text
Protocol / Renderer / Event Store tests 通过
COMP contract tests 通过
Frontend production build 通过
关键桌面与移动端 E2E 通过
无高严重度安全问题
```

---

# 54. 最终体验

用户进入 COMP Wall 时，首先看到的不是钱包、交易或参数，而是一面正在被共同创作的墙。

```text
Open
  ↓
See the community
  ↓
Leave a mark
  ↓
Wet Paint
  ↓
On-chain
  ↓
Replay history
```

底层是：

```text
COMP Shared Cell
CKB Transaction History
Deterministic Event Replay
Sponsored Network Fees
```

用户感知到的是：

> **一面所有人都能留下痕迹、任何历史都不会真正消失的公共墙。**

COMP Wall 最终应证明：共享 Cell 不只可以承载消息，也可以承载一个持续变化、由所有人共同拥有的数字空间。
