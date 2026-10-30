# Canvas Wall 二进制 payload（comp-wall v2，草案）

## 问题

现在涂鸦是一段 JSON 字符串塞进 `extensions.payload`（witness）。一次带笔画的涂鸦动辄几 KB，逼近 32 KiB 上限，也把交易体积和手续费抬得很高。

实测：120 个点的笔画 + 一行文字 + 一个圆，JSON 3701 字节，二进制 288 字节，**约 13 倍差距**。

## 布局

```
"CW" (2B) | version 0x02 (1B) | canvasW u16 | canvasH u16 | eventCount u8
```

每个事件：

| 事件 | 编码 |
| --- | --- |
| stroke (1) | rgb 3B \| width u8 \| pointCount u16 \| points |
| erase (2) | width u8 \| pointCount u16 \| points（无颜色） |
| text (3) | rgb 3B \| x u16 \| y u16 \| size u8 \| len u16 \| utf8 |
| circle (4) | rgb 3B \| width u8 \| x u16 \| y u16 \| r u16 |
| rect (5) | rgb 3B \| width u8 \| x u16 \| y u16 \| w u16 \| h u16 |
| line (6) / arrow (7) | rgb 3B \| width u8 \| x1 u16 \| y1 u16 \| x2 u16 \| y2 u16 |

点集压缩：首点用两个 u16，后续存 `zigzag(dx), zigzag(dy)` 的 varint。画布 1920×1080，u16 正好。

## 兼容

解析先看前两字节是不是 `"CW"`：是就按二进制解；不是就退回旧版 JSON，老涂鸦照常显示。

编码端先写二进制；如果消费端还没升级，写旧 JSON 也行，读端两种都认。

## 代价

- 坐标整数量化到 1px（JSON 里是浮点），肉眼无差
- 颜色只存 RGB（丢掉 alpha，本来也没用）
- 需要一套 codec，`scripts/lib/wall-codec.mjs` 是参考实现

## 参考实现

`encodeWall(events)` / `decodeWall(buffer)`，见 `scripts/lib/wall-codec.mjs`。
