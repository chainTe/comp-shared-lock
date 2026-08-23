---
name: comp-wall-artist
description: Draw, write, add shapes, erase, preview, stage, and post artwork on a COMP Wall through its AI Studio and Wall UI. Use when a user gives a COMP Wall URL or wall hash and asks Codex or Claude to paint, doodle, add text, make a mural, create a variation, or publish AI-generated marks.
---

# COMP Wall Artist

Operate the live COMP Wall UI with the browser-control capability available in
the current agent runtime. Prefer semantic labels and visible state over fixed
coordinates. Reuse the user's open Wall tab when one exists.

## Draw from a request

1. Resolve the target.
   - Use the Wall URL supplied by the user.
   - If only a hash is supplied, combine it with the current/local COMP Wall
     origin as `ORIGIN/#/wall/WALL_HASH`.
   - If the user is already viewing a Wall, use that Wall.
2. Inspect the current canvas before composing. Note occupied regions, existing
   subject matter, and the current on-chain mark count.
3. Open the same origin at `#/ai?wall=WALL_HASH`. The AI Studio preselects the
   target Wall.
4. Fill **AI art prompt** with the user's request. Preserve requested subject,
   words, colors, placement, and tone.
5. Set **AI art style** and **Artwork placement** when the request specifies
   them; otherwise keep **Find open space**.
6. Click **GENERATE PLAN**. Inspect the rendered preview and **AGENT TRACE**.
   - Use **Another take** when the first composition obscures important marks.
   - Use **Undo mark** for one unwanted event.
   - Use **Clear** before switching to a substantially different concept.
7. Click **STAGE N ON WALL**. Verify the Wall opens with `N local marks` and a
   `POST N` button.
8. When the user's request asks to place, publish, post, or draw on the Wall,
   click **POST N**. Verify **WET PAINT**, then verify the Activity entry and the
   increased on-chain mark count. If the request asks only for a preview, stop
   after generation and keep the AI Studio open.
9. Report the artwork title, event count, identity, and final status.

## Exact operations

Use **ADVANCED · EXACT EVENT JSON** when the request needs precise operations or
the generated plan requires a targeted correction. Supply one event, an event
array, or a batch object with `events`.

Supported event shapes:

```json
{"type":"stroke","points":[[120,80],[160,120]],"color":"#7861ff","width":8}
{"type":"text","x":320,"y":180,"text":"GM CKB!","color":"#151515","size":48}
{"type":"shape","shape":"circle","x":300,"y":200,"radius":50,"color":"#ffb020","width":6}
{"type":"shape","shape":"rectangle","x":300,"y":200,"rectWidth":160,"rectHeight":90,"color":"#20a46b","width":6}
{"type":"shape","shape":"line","x1":100,"y1":100,"x2":260,"y2":240,"color":"#2387ff","width":6}
{"type":"shape","shape":"arrow","x1":100,"y1":100,"x2":260,"y2":240,"color":"#f05a3c","width":6}
{"type":"erase","points":[[120,80],[160,120]],"width":24}
```

Click **Validate & preview**, inspect the canvas, then use the normal Stage and
Post flow. Keep coordinates within the 1920×1080 Wall event space and keep each
post at 64 events or fewer.

## Completion checks

- Generated preview visibly matches the request.
- Existing work remains legible unless overlap or erasure was requested.
- Staged count matches the generated Trace count.
- Posted work appears as Wet Paint and then in Activity/on-chain history.
- Leave the final Wall or AI Studio tab open for the user.

