# Canvas Wall v2 binary payload

COMP-2 keeps `extensions.payload` as a JSON string. A v2 writer puts the following
ASCII string in that field:

```text
CW2:<base64 of the binary bytes below>
```

The `CW2:` prefix selects v2. A reader that does not see this prefix continues
to parse the historical `comp-wall` v1 JSON batch or single-event payload. A v1
reader cannot display v2 posts until it is upgraded. The 32 KiB payload limit
applies to the UTF-8 bytes of the complete `CW2:` string, including base64.

## Binary layout

All u16 values are little-endian. The 8-byte header is:

```text
"CW" (2 bytes) | version 0x02 (1 byte) | canvasW u16 | canvasH u16 | eventCount u8
```

`canvasW` and `canvasH` must be 1920 and 1080. A batch has 1–64 events.

| Event type byte | Remaining bytes |
| --- | --- |
| 1 stroke | rgb 3B · width u8 · pointCount u16 · points |
| 2 erase | width u8 · pointCount u16 · points |
| 3 text | rgb 3B · x u16 · y u16 · size u8 · utf8Length u16 · UTF-8 bytes |
| 4 circle | rgb 3B · width u8 · x u16 · y u16 · radius u16 |
| 5 rectangle | rgb 3B · width u8 · x u16 · y u16 · rectWidth u16 · rectHeight u16 |
| 6 line / 7 arrow | rgb 3B · width u8 · x1 u16 · y1 u16 · x2 u16 · y2 u16 |

RGB contains the three bytes from `#RRGGBB`; alpha is absent. Erase has no color
bytes. A point set has 2–2,048 points. The first point uses absolute `x u16,
y u16`; each subsequent point uses unsigned base-128 varints for
`zigzag(dx), zigzag(dy)`, relative to the preceding rounded point. Zigzag maps
`n >= 0` to `2n` and `n < 0` to `-2n - 1`.

The writer rounds coordinates, brush width, text size, and circle radius to
integer pixels. A rectangle drawn in a reverse direction is normalized to its
top-left corner and positive width and height before encoding. If rounding
would invalidate an otherwise valid v1 event, the writer keeps that batch as
v1 JSON so the drawing remains representable.

Readers reject invalid base64, unknown versions or event types, truncated or
trailing bytes, out-of-range event data, and batches above the payload limit.
The frontend codec lives in `frontend/src/wallBinary.ts`; the COMP-2 string
writer and the v1/v2 dispatcher live in `frontend/src/compWall.ts`.
