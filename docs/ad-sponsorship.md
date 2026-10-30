# 赞助署名（草案）

## 问题

共享 Cell 的门槛很低，但没人有理由长期替陌生人出容量。得给资助者一点回报，又不能靠服务器。

## 主张

**谁供给容量，谁的署名就写在这片空间上。**

- 创建 gas cell 时，把创建者/赞助方写进频道元数据
- 元数据的哈希就是 `channel_hash`（lock args 的前 32 字节）
- lock args 由合约保证逐字节不可变 → **署名天生不可篡改**
- 每笔交易在前端显示「由 X 赞助」；客户端不认，也不影响合约

## 数据格式

频道元数据（创建交易的 cell data）：

```json
{
  "protocol": "comp",
  "version": 2,
  "type": "channel",
  "name": "小鲸",
  "slug": "xiaojing",
  "kind": "chat",
  "creator": "0x…",
  "sponsor": { "name": "X", "url": "https://example.com" }
}
```

`channel_hash = blake2b_256(canonical_json(metadata))`，canonical 指键排序、无空格的 JSON。

## 校验

客户端读频道 cell 时：

1. 取 lock args 的前 32 字节作为 `channel_hash`
2. 对元数据做 canonical JSON 与 blake2b
3. 对不上就说明元数据被改过，展示时降级为「未验证」

参考实现：`scripts/lib/sponsor.mjs`（`metadataHash` / `verifyMetadata`）。

## 兼容

老频道（`channel_hash` 是随机值）校验必然不通过，前端按「历史频道」处理即可，不影响收发消息。

## 权衡

- 署名不可删 → 不好的赞助方也只能靠前端屏蔽，合约管不了
- 广告文字放元数据要占容量（1 字节 ≈ 1 CKB），所以只放短名和链接
- 需要真有赞助商才值得做；现在先把约定和校验实现放进去，前端以后接
