# 赞助署名（草案）

## 问题

共享 Cell 的门槛很低，但没人有理由长期替陌生人出容量。得给资助者一点回报，又不能靠服务器。

## 主张

**谁的 cell，广告就跟着谁。**

- 每个赞助方自己建 cell，data 里写自己的名字（链接可选）
- 同一频道可以有很多个 cell（多个赞助商）
- 用户用哪个 cell 发交易，展示的就是那个 cell 的赞助商
- 合约只要保证 **花的时候 data 不能变**，赞助信息就改不了

## 为什么这样分

频道哈希仍按名字算（`frontend/src/channelNames.ts`），所以同名频道天然共享一个身份；赞助商不参与哈希，可以各自独立地加进来。

不需要数组，也不需要注册表：多一个赞助商，就是多一个 cell。

## 数据格式（comp-meta v2，二进制）

JSON 太占地方（一个频道快 120 字节 ≈ 120 CKB），改成紧凑二进制：

```
[0]     版本 0x02
[1]     flags（bit0 = 带赞助商）
[2..4]  name_len（u16 LE）
[4..]   name（UTF-8）
[..]    kind（u8：0=chat, 1=wall）
[..]    sponsor_len（u8，0 = 没有）
[..]    sponsor（UTF-8）
```

例：`name="小鲸", kind=chat, sponsor="鱼铺"` → 18 字节：

```
02 01 06 00 e5b08fe9b2b8 00 06 e9b1bce993ba
```

老频道是 JSON，解析器先认 `0x02`，不认就退回按 JSON 读。

参考实现：`scripts/lib/sponsor.mjs` 的 `encodeMetadata` / `parseMetadata`。

## 合约（v0.4 草案）

在 v0.3 的规则上加一条：

- `successor.data` 必须与 `input.data` **逐字节一致**，否则返回 `DataMutated`

`args` 结构不变：`channel_hash(32) || max_fee(8, LE)`，无需标志位。

## 展示

1. 客户端按 lock args 找到频道下的所有 cell
2. 读每个 cell 的 data，取出 `sponsor`
3. 用户发消息时用某个 cell，就在这条消息旁边显示「由 X 赞助」

## 权衡

- 改名/换赞助商都不行，只能重新建 cell（旧 cell 自然废弃）
- 同名的假频道可以自己建 cell，但它只能代表它自己的广告，冒充不了别人的 cell
- data 占容量（1 字节 ≈ 1 CKB），只放一个短名字就够了，链接/头像能省则省

## 参考实现

`scripts/lib/sponsor.mjs`：`parseMetadata(data)`、`isImmutableTransition(inputData, outputData)`。
