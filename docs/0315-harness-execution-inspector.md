# Harness Execution Inspector — Implementation Spec

> Status: Implemented — 2026-10-20; ตรวจ component/Harness behavior, live theme matrix และ native WKWebView focus/copy แล้ว
> Amended by: [319](./0319-harness-execution-inspector-dialog.md) — the inline `ExecutionPanel` in the card slot is replaced by a modal `ExecutionDialog`; §Solution, §UI, keyboard and rendering, and §Ownership and data flow below describe the superseded inline panel. Recognition, normalization, status, bounds and retention still apply.
> Date: 2026-10-20
> Milestone: ACP Harness — execution observability
> Scope: frontend สำหรับ OMP code cells เท่านั้น; ไม่เปลี่ยน OMP, Rust, ACP wire หรือวิธี execute
> Extends: [72](./0072-acp-harness-view.md), [103](./0103-acp-harness-transcript-window.md), [301](./0301-harness-ui-components.md), [302](./0302-harness-component-catalog.md), [310](./0310-harness-genui-inline-panel.md)

## Problem

OMP `eval` ปรากฏเป็น tool ชนิด `execute` โดยชื่อและ ACP content มี source code ซ้ำกัน ผู้ใช้ต้องอ่าน code dump เพื่อหาว่ากำลังทำอะไร ผลลัพธ์มาถึงหรือยัง และเกิดข้อผิดพลาดตรงไหน ฝั่ง Harness มีข้อมูลจริงอยู่ก่อนสร้าง display payload แต่ยังไม่เก็บเป็น execution model

## Solution

เพิ่ม execution card ใน **tool transcript item เดิม**: language, ชื่องาน, สถานะ, เวลา, activity ล่าสุด และปุ่มเปิด Inspector กดแล้วขยาย inline เป็น Code / Output / Activity ของ call เดียวกัน ไม่สร้างข้อความซ้ำ ไม่เปิด native window หรือ OS browser

การ์ดเริ่มแบบย่อเสมอ Inspector มีหนึ่ง instance ต่อ Harness และย้ายไปยังการ์ดที่ผู้ใช้เลือก ใช้ ownership/mount pattern ของ spec 310: view เป็นเจ้าของ panel; row เป็นเจ้าของ summary และ slot เท่านั้น การเปิด panel ไม่ execute, edit, retry หรือส่งข้อความให้ agent

## Research

### ยืนยันกับ runtime ที่ใช้งานจริง

- `/Users/wk/.local/bin/omp --version` เป็น `18.12.3`; source checkout `/Users/wk/Source/oh-my-pi` เป็น `16.3.11` จึงใช้ checkout นั้นเป็นแผนที่ source ไม่ใช่หลักฐานของ payload ปัจจุบัน
- Smoke ใช้ binary `18.12.3` ใน temporary cwd/agent directory, ephemeral session, ปิด ambient extensions/skills/rules และใช้ local provider fixture แทน model ภายนอก ตัว `eval`, Python/JS runtime และ ACP transport เป็นของจริง ไม่เรียก GitHub หรือ voice endpoint
- ตรวจ Python success, JS success, JS exception และ JS `console.table()`; ได้ `tool_call` / `tool_call_update` ที่ผูกกับ `toolCallId` เดิม
- Start ส่ง `kind: "execute"`, `status: "pending"`, `rawInput: { language, title, code }`; ไม่มี `name`, `toolName` หรือ `_meta` ที่ระบุ `eval` ชัดเจน `title` และ ACP content มี code ต่อท้าย
- Live update ส่ง `status: "in_progress"`, `rawOutput.details.cells[0]` พร้อม `code`, `language`, `output`, `status: "running"`, `statusEvents` ผลเป็น **snapshot** ไม่ใช่ delta
- Python input `language: "py"` กลับมาเป็น cell `language: "python"`; JS ใช้ `"js"` ผลสำเร็จเป็น cell `status: "complete"`, `durationMs`, `exitCode: 0` และ ACP `completed`
- Exception เป็น ACP `failed`, cell `error`, `exitCode: 1`, `details.isError: true`; traceback อยู่ใน output แล้ว ไม่ต้องสร้าง traceback ขึ้นเอง
- `phase()` ส่ง `{ op: "phase", title }`; `log()` ส่ง `{ op: "log", message }` ไม่มี phase ID, timestamp หรือ phase-completed event จึงไม่อนุมานขั้นตอนสำเร็จ จำนวนงาน หรือเปอร์เซ็นต์
- Final `views[]` ที่ตรวจพบมี `{ text, view: { kind: "json", value } }` และ `{ text, view: { kind: "table", columns: [{ head, numeric? }], rows: string[][] } }` ไม่ต้องแปลง stdout กลับเป็น JSON
- ไม่มี waiting/stalled status สำหรับการเงียบของ output ใช้ `Running · ยังไม่มี output` เมื่อยังไม่มีข้อความ ไม่ใช้ inactivity timer เดาสถานะ `Waiting`
- Live elapsed ใช้เวลาที่ client สังเกต call; final runtime duration ใช้ `cell.durationMs` เมื่อมี และแยกที่มาของเวลาให้ชัด

### จุดเชื่อมใน Krypton

- `src-tauri/src/acp.rs:1665-1692` ส่ง `params.update` ทั้ง object ต่อใน Tauri event; `src/acp/client.ts:307-311` ส่ง tool updates ต่อโดยไม่คัด fields ไม่ต้องเพิ่ม IPC หรือ ACP capability
- `AcpHarnessView.renderTool()` ใช้ `lane.toolTranscriptIds` จับคู่ call → transcript item และ `mergeToolCall()` เก็บ partial updates
- `buildToolPayload()` ใน `harness-tool-render.ts` แปลงผลเป็น sections และตัดเหลือ 12 บรรทัดสำหรับ execute; `boundedOutputLines()` ยังตัดแต่ละบรรทัดที่ 140 ตัวอักษร จึงใช้ sections นี้เป็น source ของ Inspector ไม่ได้
- `compactToolCallForRetention()` เปลี่ยน raw input/output ที่ใหญ่กว่า 12K/16K code units เป็น string และไม่เก็บ `_meta`; ต้อง decode execution จาก **incoming update ก่อน compaction** แล้วเก็บบน display payload ที่มีขอบเขตของตัวเอง
- Probe นำ frames ที่ capture จาก binary จริงเข้า `buildToolPayload()` / merge / retention จริงของ Krypton: subject ยังมี source และไม่มี execution fields; เมื่อเกินขนาด raw input/output กลายเป็น string ตามที่ source ระบุ
- `ToolRow` มี stable DOM, dependency tuple และ terminal seal อยู่แล้ว; `genUiPanel` มี view-owned inline mount, focus ownership และ scroll-anchor pattern ที่นำมาใช้ได้ โดยไม่สร้าง generic panel framework ใหม่
- `lane.transcript` ใน control API (`acp-harness-view.ts:2260-2270`) project เฉพาะ fields ที่กำหนด ไม่ส่ง `item.tool` ทั้ง object; execution model เป็น internal display state งานนี้คง public projection และ telemetry เดิม ไม่ส่ง code/output ชุดใหม่ออกไป
- `theme.ts:461-496` derive `--agent-*` จาก active theme รวม light scheme จึงห้ามบังคับ amber/cyan/gold แบบ fixed palette; `genui-panel.css:12-16` แยก structural border ออกจาก accent เพื่อไม่ให้ panel แย่งสายตาจาก transcript
- `harness-markdown.ts:12` import `highlight.js/styles/github-dark.css` อยู่แล้ว การเพิ่ม layered selector อย่างเดียวไม่รับประกันว่าจะชนะ unlayered `.hljs-*` rules; syntax markup ของ Inspector ต้องใช้ component-owned class prefix และ theme tokens โดยไม่แก้ global highlighter configuration หรือ CSS ของหน้าอื่น

## Prior Art

| App | Implementation | สิ่งที่นำมาใช้ / ไม่ใช้ |
|-----|----------------|-----------------------|
| Zed ACP | เลือก specialized renderer จากข้อมูล content; expansion keyed ด้วย tool-call ID; แยก command กับ output และมี bounded output viewport | ใช้ identity เดิมและ disclosure; ไม่ถือว่า `kind: execute` หมายถึง terminal หรือ eval เสมอ |
| JupyterLab | ย่อ Code และ Output แยกกัน และ scroll output ที่ยาวได้ | ใช้การแยก source/result; ไม่เพิ่ม notebook document, editor, kernel controls หรือ run button |
| VS Code Notebook | Output อยู่ใต้ code cell; line numbers และ execution feedback แยกจาก source | ใช้ความอ่านง่าย; ไม่เพิ่ม cell editing/reordering/debugging |

Zed source ที่ตรวจ: `crates/agent_ui/src/conversation_view/thread_view.rs:8412-8679,8751-8816`, `entry_view_state.rs:43-97`, `crates/acp_thread/src/acp_thread.rs:1447-1487,5284-5322` ใน `/Users/wk/Source/zed`

**Krypton delta:** summary อยู่ใน transcript เดิม รายละเอียดเปิด inline ด้วย keyboard; ไม่ใช่ notebook หรือ terminal session ใหม่ หน้าจอจริงใช้ Harness theme tokens ไม่คัด palette Binance ของ HTML mockup มาใช้

## Affected Files

| File | Change |
|------|----------------|
| `src/acp/harness-execution.ts` (new) | Boundary schemas, bounded normalization, snapshot merge, status derivation, safe view matching |
| `src/acp/harness-execution.test.ts` (new) | Consumer-visible parsing, replacement, bounds, errors และ omitted-field behavior |
| `src/acp/harness-view-types.ts` | `ExecutionPayload`, optional `ToolPayload.execution`, stable execution hint target บน transcript item |
| `src/acp/acp-harness-view.ts` | Decode ก่อน retention, hint/click/key routing, one view-owned panel, mount/close/teardown และ scroll anchoring |
| `src/acp/components/tool-row/` | Seat `ExecutionCard`, live child updates, slot/hint methods, suppress duplicated generic sections เฉพาะ execution |
| `src/acp/components/execution-card/` (new) | Compact read-only summary และ panel slot; class/CSS/tests อยู่ด้วยกัน |
| `src/acp/components/execution-panel/` (new) | Code / Output / Activity, native controls, copy, rich table/JSON presentation และ own disposal |
| `src/acp/components/registry.ts` | ลงทะเบียน component blocks ตาม convention เดิม |
| `src/acp/components/execution-integration.test.ts`, `src/acp/components/harness-integration.test.ts`, `src/acp/acp-harness-view.test.ts` | Event → row/panel behavior, item/sibling identity, focus/mount, eviction และ shared reveal regression |
| `AGENTS.md` constraint 10 | ขยายข้อยกเว้น view-owned inline panel ที่ระบุ GenUI ให้ครอบคลุม Execution Inspector อย่างเจาะจง; ไม่ผ่อนข้อห้าม repaint ทั่วไป |
| `docs/0002-functional-requirements.md`, `0004-architecture.md`, `0005-data-flow.md`, `0072-acp-harness-view.md`, `0235-harness-tool-output-palette.md`, `0301-harness-ui-components.md`, `0302-harness-component-catalog.md`, `docs/README.md` | Requirements, ownership/data-flow contract, generic-output scope และ component catalog ตาม implementation |

## Design

### Data Structures and API

```ts
export interface ExecutionActivity {
  readonly op: string;
  readonly text: string;
  readonly detail: string; // bounded JSON text สำหรับ event ที่ไม่ใช่ phase/log
}
export type ExecutionView =
  | { readonly kind: 'json'; readonly text: string; readonly json: string }
  | { readonly kind: 'table'; readonly text: string;
      readonly columns: readonly { head: string; numeric?: boolean }[];
      readonly rows: readonly (readonly string[])[] };
export interface ExecutionPayload {
  readonly source: 'omp';
  readonly language: 'py' | 'js';
  readonly title: string;
  readonly code: string;
  readonly output: string | null; // null = ยังไม่มี result snapshot
  readonly observedLive: boolean; // เคยรับ pending/in_progress จริง ไม่ใช่ terminal-only replay
  readonly cellStatus: 'pending' | 'running' | 'complete' | 'error' | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly isError: boolean;
  readonly activity: readonly ExecutionActivity[];
  readonly views: readonly ExecutionView[];
  readonly detached: { readonly jobId: string; readonly state: string } | null;
  readonly truncated: readonly ('code' | 'output' | 'activity' | 'views')[];
}
export interface ExecutionOpenTarget {
  executionItemId: string;
  hintLabel: string | null;
}
// ToolPayload.execution?: ExecutionPayload
// HarnessTranscriptItem.executionTarget?: ExecutionOpenTarget
export function parseExecutionPayload(
  backendId: string,
  update: ToolCall | ToolCallUpdate, // incoming, ยังไม่ถูก compact
  previous?: ExecutionPayload,
): ExecutionPayload | undefined;
export interface ExecutionPanelProps {
  readonly open: boolean;
  readonly payload: ExecutionPayload | null;
  readonly status: string; // ACP tool-call status
  readonly takeFocus: boolean;
  onClose(restoreFocus: boolean): void;
}
```

`ExecutionPanel` เป็น `Component<ExecutionPanelProps>` ที่ view เป็นเจ้าของ มี `isOpen`, `hasFocus`, `handleKey(event)` และ `close(restoreFocus)` ตาม inline-host convention เดิม ไม่มี timer ใน panel; เวลาอยู่ที่ card header ซึ่งรับ `ToolPayload.startedAt/endedAt` ไม่มี command, MCP tool, config หรือ persisted schema ใหม่

### Recognition and normalization

1. เฉพาะ `backendId === 'omp'` รองรับ current one-cell contract เท่านั้น Start ต้องเป็น execute และผ่าน loose TypeBox schema ของ `rawInput.language ∈ {py, js}` กับ `code: string` ไม่ใช้ title regex หรือ `kind` อย่างเดียว
2. Result-only/replayed call ใช้ validated `rawOutput.details.cells` ที่มี **หนึ่ง cell** พร้อม code และ language ที่รู้จักได้ แปลง `python → py`; อื่น ๆ ใช้ generic tool row เดิม ไม่เพิ่ม legacy input/cells parser
3. ACP ปัจจุบันไม่มี canonical eval name ดังนั้นนี่เป็น **constrained shape recognition** ไม่ใช่การยืนยันชื่อ tool จาก protocol ถ้า OMP custom tool ใช้ execute และ schema เดียวกัน มันอาจได้ renderer นี้ด้วย; การแสดงผลไม่เพิ่มสิทธิ์ execution
4. Title ใช้ input/cell `title` ที่มีค่า มิฉะนั้น `Python execution` / `JavaScript execution` ไม่ใช้ ACP title ที่มี code ต่อท้ายเป็นชื่อการ์ด
5. Parser รับ incoming update โดยตรง Omitted input/output เก็บ previous fields ไว้; status-only update คืน previous execution object ได้เพื่อรักษา identity ไม่อ่าน source กลับจาก compacted wire state `observedLive` เริ่มจริงเมื่อรับ explicit pending/in_progress และคงค่านั้นข้าม updates; terminal-only replay เริ่ม false
6. เมื่อมี result snapshot ให้ **replace** output/activity/views ที่ส่งมา ไม่ append snapshot ซ้ำ ส่วน source/title ที่ update ไม่ส่งยังเก็บไว้ Final exception ที่ไม่มี cells ใช้ข้อความของ `rawOutput.content` หรือ generic raw-output text เป็น error output โดยคง source เดิม ไม่ปล่อยให้ข้อมูลเดิมซ่อน error ใหม่
7. Cell output `''` เป็น output ที่ว่างจริง ไม่ fallback ไปแสดง ACP content ที่ echo source เมื่อไม่มี typed output ให้แสดงข้อความว่ายังไม่มีผลลัพธ์
8. ใช้ boundary validation และ text-safe normalization ตาม `harness-subagents.ts` ไม่ cast unchecked payload หรือ parse Python repr/stdout เป็น data

### Status, timing and activity

- ลำดับ precedence: explicit ACP canceled → **Cancelled**; cell `error`, `details.isError`, nonzero exit หรือ ACP failed → **Error**; detached runtime ที่ยัง running → **Background · last reported**; ACP pending → **Pending**; active call → **Running**; completed call ที่ไม่มี error → **Done**
- Cell กับ ACP status เก็บแยกกัน จึงไม่ทำให้ cell error กลายเป็น Done เพียงเพราะ tool envelope completed ทั้งนี้ห้ามแก้ execution outcome ฝั่ง OMP ในงานนี้
- Background metadata เมื่อมี `details.async.state === 'running'` แสดง **Background · last reported** พร้อม job ID เป็น static snapshot เมื่อ tool คืนผล ไม่แสดง Done, live spinner หรือนาฬิกาที่เดินต่อ และไม่อ้างว่ามี subsequent same-ID settlement ยังไม่ได้ probe eval auto-background ของ binary นี้
- Running ใช้ shared existing tool timer เฉพาะเมื่อ `observedLive` เป็นจริง Final ใช้ reported `durationMs` ถ้ามี; ถ้าไม่มีใช้ observed call duration พร้อม label แยก provenance เฉพาะ call ที่เคยเห็น live ถ้าเป็น terminal-only replay ให้ซ่อนเวลาแทนการแสดงเวลาที่ replay ไม่มี CPU-time claim หรือ timestamp สร้างย้อนหลัง
- Activity เป็นรายการ phase/log/tool-summary ที่ backend ส่งมาจริงตามลำดับ snapshot highlight phase ล่าสุดได้ แต่ไม่สร้าง checkmarks, phase-end times หรือ progress percentage จากลำดับ event ไม่มี nested full tool transcript หรือการรวม status events ข้าม calls
- `Running · ยังไม่มี output` บอกเฉพาะการไม่มีข้อความ ไม่ใช่ runtime Waiting/stalled state ข้อมูลที่ไม่มีให้ซ่อนหรือระบุ unavailable ไม่ใส่เลขศูนย์แทน

### Bounds and lifetime

- ไม่เพิ่ม full-payload cache หรือ disk store: typed payload อยู่บน item ภายใต้ transcript cap 300 / tail window ตาม spec 103 และถูกปล่อยพร้อม item
- งบ strings รวมไม่เกิน **64K UTF-16 code units ต่อ execution** รวม markers และ `view.text`: source prefix ≤16K, output tail ≤24K, activity tail ≤16 events รวม ≤4K, structured views รวม ≤16K; title ≤256, op ≤32 และ job ID ≤128 ใช้งบที่เหลือ จำกัดแต่ละ field ก่อนรวม และลด views ก่อน activity เมื่อเกินงบ
- ไม่เกิน 8 views; table ≤100 rows / 20 columns, string ต่อ cell ≤256 code units; JSON เก็บเป็น bounded serialized text ไม่เก็บ arbitrary object tree ซ้ำ การตัดต้องติด marker และ `truncated` ชัดเจน
- Inspector ไม่เปิดไฟล์จาก `%load` ไม่ fetch `artifact://` และไม่ดึง output ที่ spill กลับมาเอง Copy คัดลอกได้เฉพาะ source ที่เก็บอยู่ ถ้าถูกตัด button ต้องระบุ `Copy shown code` และแจ้งว่าข้อมูลไม่ครบ
- View/tab/lane reset, close หรือ row หายจาก mounted window ปิด panel โดยไม่แย่ง focus ไม่ retain payload อีกสำเนาผ่าน open-target state

### UI, keyboard and rendering

Compact card ใช้ header เดิมของ tool: status glyph, Python/JavaScript, title, elapsed และปุ่ม `Inspector` พร้อม hint label; มี activity ล่าสุดได้หนึ่งบรรทัด ไม่แสดง source dump ซ้ำ Generic sections ถูกแทนที่เฉพาะ recognized execution; diffs และ image strip เดิมยังอยู่ ลำดับ precedence คือ artifact redaction → subagent card → execution → generic

เมื่อเปิด Inspector:

- Code read-only มีเลขบรรทัดและ Copy ใช้ dependency `highlight.js` ที่ repo มีอยู่แล้ว ระบุ language ตรง ๆ ไม่ auto-detect highlight เฉพาะตอน source เปลี่ยน/เปิดครั้งแรก ไม่ทุก output tick
- Output ค่าเริ่มต้นเป็น formatted text มีตัวเลือก Raw/Formatted เมื่อมี recognized views; แสดง table/JSON เฉพาะข้อมูลที่ backend ส่งมา ไม่สร้างตารางจากข้อความธรรมดา
- Rich view แทน `view.text` ได้เมื่อข้อความนั้นตรงกับหนึ่ง span ที่ไม่กำกวมใน retained output เท่านั้น ถ้าตรงหลายตำแหน่ง/ไม่ตรง/ถูกตัด ให้คงข้อความเดิม ไม่ลบ output หรือพิมพ์ทั้ง rich view และข้อความซ้ำ Unsupported view เช่น markdown คง text ที่ backend ให้; ไม่ execute HTML
- Traceback ใช้ output ของ backend ตามจริง สี error ไม่ต้องแยก stack ด้วย regex รูปภาพใช้ `collectToolImages()` / image strip เดิม ไม่ duplicate ใน panel
- Code/Output วางสองคอลัมน์เมื่อ panel กว้างอย่างน้อย 900 CSS px; แคบกว่านั้น stack แนวตั้ง แต่ละ pre มี horizontal scroll; ไม่มี page-level horizontal overflow
- Activity อยู่ใต้ Code/Output; ไม่มี synthetic clock/checkmarks Header ไม่แสดง `cell 18` แบบ global notebook count เพราะ index เป็น local ต่อ call
- ใช้ inherited Harness font/theme tokens, full 1px border หรือ divider เดิม ไม่มี nested card frame, left rail, corner brackets, blur หรือ shadow/backdrop ใหม่ CSS อยู่ใน `krypton.component`/`krypton.scheme` และ component-scoped `[hidden] { display: none }`

| Key / action | Context | Result |
|--------------|---------|--------|
| `f` แล้ว `<label>` | Transcript focus, mounted execution card | Toggle Inspector ของ item นั้น; ไม่สร้าง global shortcut ใหม่ |
| Click `Inspector` | Card | เปิด/ปิด target เดิม; เลือก call อื่นย้าย panel node เดิม |
| `Tab` / `Shift+Tab` | Panel focused | เดิน native controls ตาม inline-panel focus convention |
| `Enter` / `Space` | Focused button/disclosure | Copy, toggle Code หรือเปลี่ยน output view |
| `Escape` | Panel focused | ปิด แล้วคืน focus composer; overlay ที่เปิดทับอยู่มี precedence ก่อน |

ไม่มี `1–4`, `E`, `K` ของ mockup เป็น shortcut production เมื่อ panel เปิดแต่ไม่ได้ focus การพิมพ์ยังเป็นของ composer; pointerdown บน control focus ด้วย `preventScroll` และยกเลิก default focus reset ของ WKWebView เฉพาะปุ่ม โดยไม่ยกเลิก text selection ใน Output

### Visual integration contract

**ข้อกำหนดจากผู้ใช้:** Execution Inspector ต้องดูเป็นส่วนหนึ่งของ Krypton Harness ไม่ใช่ UI อีกชุดที่ฝังเข้ามา HTML mockup ใช้อธิบายข้อมูลและ interaction เท่านั้น ไม่ใช่ visual specification

| ส่วน | ใช้ contract เดิม |
|------|------------------|
| Typography | Inherit `--agent-font` และ `--krypton-font-size`; title/output ขนาดเดียวกับ tool row รอบข้าง Labels/timer ใช้ relative sizing เดิม และตัวเลขใช้ tabular-nums ไม่กำหนด font family หรือ display heading ใหม่ |
| Density / alignment | Header gap 8px, row rhythm 4px และ glyph cell 1.4ch ตาม `tool-row.css`; title, status และ timer วางแนวเดียวกับ tool อื่น ไม่มี page-like header หรือ padding แบบ artifact |
| Inline panel | ใช้ neutral foreground hairline ที่ alpha 0.1 และ inset 12px ตาม `genui-panel.css`; ไม่มี outer dashboard card หรือ nested frame เพิ่ม สีพื้นตาม parent ไม่สร้างแผ่นดำ/ขาวทึบใหม่ |
| Geometry | Border 1px; radius อ่าน `--krypton-border-radius` ในจุดที่ต้องมีกรอบ ไม่ hard-code radius 10px จาก mockup หรือวาด corner brackets |
| Color / emphasis | เนื้อหาใช้ `--krypton-fg`/`--krypton-fg-rgb`; accent/focus ใช้ resolved `--krypton-window-accent`; running/done/error ใช้ `--agent-gold`/`--agent-accent`/`--agent-error` ตาม ToolRow สีต้องเปลี่ยนตาม theme ไม่บังคับ Binance yellow หรือ default amber |
| Controls | Copy, Code disclosure และ output-view toggle ใช้ quiet inline-button treatment ของ `GenUiPanel`: font inherit, transparent fill, padding 1px 6px, low-alpha hover border และ focus-visible 1px offset 2px ไม่ใช้ปุ่มน้ำหนักเท่า dialog |
| Syntax highlighting | ใช้ engine เดิม แต่เปลี่ยน token classes เป็น `acp-execution-panel__syntax-*` ภายใน component; สีอ้างอิง resolved `--krypton-ansi-*` ตามแนวทาง file preview Base text/background inherit; ไม่ import syntax theme เพิ่ม ไม่เรียก global `hljs.configure()` และไม่เพิ่ม global `.hljs` overrides |
| Theme overrides | Component-specific hooks ใช้ `--acp-execution-*` กับ fallback ไป existing theme tokens ตาม spec 303 และลงรายการใน component catalog ไม่เพิ่ม theme schema/config ใหม่ |
| CSS isolation | ทุก selector gated ด้วย block ที่ component เป็นเจ้าของและอยู่ใน `krypton.component`/`krypton.scheme`; ห้าม selector กว้าง เช่น `button`, `pre`, `.hljs` ที่มีผลนอก Inspector ห้ามแก้ global reset, typography หรือ palette เพื่อให้ feature นี้ดูถูกต้อง |
| Motion | ใช้ Spinner/shared timer เดิมเท่านั้น ไม่มี decorative pulse หรือ expand animation ใหม่ Respect reduced motion; terminal/sealed card ต้องนิ่ง |

การ reuse หมายถึง primitive ที่มีอยู่และค่าจาก contract เดิม ไม่ import CSS ข้าม component เพื่อยึด DOM ของ GenUI หรือสร้าง abstraction ของ design system ใหม่

### Ownership and data flow

1. `tool_call` / `tool_call_update` เข้า `renderTool()` ตามเดิม จับคู่ด้วย lane + toolCallId และสร้าง/อัปเดต **item เดิม** ไม่สร้าง item ต่อ chunk
2. หลัง merge display payload และตรวจ redaction/subagent ให้ decode incoming update เป็น `tool.execution` ก่อน `compactToolCallForRetention()` สร้าง stable `executionTarget` ครั้งเดียวและเก็บ hint label ข้าม snapshots
3. `ToolRow` สร้าง `ExecutionCard`/slot ครั้งเดียว โดย card **แทนที่** generic head/output ไม่ใช่เพิ่ม header ซ้ำ Card ใช้ `Spinner` เดิม และ timer node ตาม contract `.acp-harness__tool-timer[data-started-at][data-ended-at]` ของ shared ticker; terminal node ต้องมี `data-ended-at` หรือไม่อยู่ใน ticker set Structural deps อ่าน presence/title/language/status ที่จำเป็น; `appendChunk()` ส่ง output/activity ไป owning child โดยตรง ไม่ rebuild head หรือ transcript sibling
4. เมื่อผู้ใช้เปิด view เก็บเพียง `{ laneId, itemId }`, capture scroll anchor, mount panel node แล้ว update props/focus Restore anchor และ reveal เฉพาะ user open ใช้ capture/restore/bounded reveal code เดิม โดยแยก private reveal helper ที่รับ card element แทนการคัดลอก scroll algorithm
5. หลัง transcript commit `syncExecutionMount()` re-seat node เดิมเมื่อ slot ยังอยู่ ถ้าไม่อยู่ปิดแบบ `restoreFocus=false` ไม่สั่ง render ทั้ง view มีหนึ่ง Execution Inspector ต่อ Harness ไม่จำเป็นต้องปิด GenUI ที่ไม่ได้ focus
6. Terminal transition paint ผลสุดท้ายแล้ว `LiveComponent.seal()` ตามเดิม Row หยุด spinner/timer ไม่ render จาก turn-end handler; panel ไม่มี timer ของตัวเอง User toggle หลัง seal เปลี่ยนเฉพาะ view-owned panel/slot ผ่าน owning component method ไม่ `ToolRow.paint()`
7. อัปเดตข้อยกเว้นใน constraint 10 และ spec 301 ให้ชื่อ Execution Inspector ชัดเจน เช่นเดียวกับ GenUI: live controls เป็นของ view, ไม่เข้า row dependency tuple และไม่อนุญาตให้ feature อื่นแก้ sealed row โดยอิสระ
8. Hint labels patch ผ่าน owning execution-card method เช่น GenUI ไม่เอา open/output-view state เข้า sealed-row deps; payload changes ที่ไม่ได้เปลี่ยนข้อมูลจริงรักษา reference identity

## Edge Cases

- Concurrent calls/lane switching: keys ไม่ใช้ title หรือ cell index; เปิดได้เฉพาะ mounted item ของ active lane ปิดเมื่อเปลี่ยน lane โดยไม่คืน focus ผิด lane
- Replayed start ที่ completed แล้วตามด้วย result: merge เข้ารายการเดิม ไม่จอง cell ใหม่ ไม่สรุป runtime duration จากเวลาที่ replay; ใช้ reported duration หรือ unavailable สำหรับ replay ที่ไม่มี timing จริง
- Metadata-only update หลัง retention: source/output/activity เดิมยังอยู่ ไม่หายเมื่อ raw wire กลายเป็น string
- Backend exception ก่อนมี cell details: source จาก start ยังเปิดได้ error ใหม่ต้องมองเห็น; ถ้าไม่เคยมี valid source ให้ใช้ generic error row เดิม
- Large / repeated / malformed view data: bounded fallback เป็น backend text ไม่ execute HTML และไม่ซ่อนส่วนที่ parse ไม่ได้
- Empty output และ output ที่มีแต่ image: บอกว่าไม่มี text output โดยยังเห็น image strip; ไม่เอา source echo มาแทนผลลัพธ์
- Hidden tab/eviction/disposal: ไม่มี animation หรือ timer ของ inspector ค้าง; ไม่ทำ disk/network I/O เพื่อชุบข้อมูลที่ถูกปล่อยไปแล้ว
- Live output ขณะเลือก text/scroll อ่านผลเก่า: preserve pane DOM/focus/selection เท่าที่ข้อมูลเดิมยังอยู่ และเลื่อนลงเฉพาะเมื่อ output pane อยู่ท้ายก่อน update ไม่ดึงคนอ่านกลับท้าย

## Verification

### Research smoke ที่ทำแล้ว

- Installed OMP `18.12.3`: local fixture provider → real eval → real ACP, Python/JS success, JS exception และ table/JSON views ตรวจชื่อ fields จาก frames จริง ไม่ใช้ source checkout รุ่นเก่าแทน
- Frames จริง → current Harness payload/merge/retention functions: ยืนยันจุดที่ข้อมูลหายและ source ถูกแสดงซ้ำ Probe เป็น throwaway ไม่มี external model, GitHub request หรือ permanent test เพิ่มในขั้น design
- Artifact mockup ตรวจสลับสถานะ, expand/collapse, output views และ desktop/narrow layout แล้ว ไม่ใช่หลักฐานว่า implementation นี้เสร็จหรือ Waiting เป็น runtime state

### Acceptance หลังอนุมัติและ implementation

1. Python/JS start → running snapshots → complete/error แสดงหนึ่งการ์ดต่อ call; metadata-only update ไม่ทำ code/output หาย และ snapshot replacement ไม่เพิ่มข้อความซ้ำ
2. Generic bash, custom tools ที่ไม่ตรง execution schema, non-OMP lanes, subagent cards, redacted artifact writes และ legacy input shapes คง renderer เดิม Custom tool ที่ใช้ OMP execute พร้อม schema เดียวกันเป็นข้อจำกัดของ recognition ตามที่ระบุ ไม่อ้างว่า protocol ยืนยันชื่อ tool ได้
3. เปิดจาก `f` hint และ pointer ได้ ใช้ Code/Output/Copy ได้จริงทั้ง live และ sealed โดย row/sibling DOM identity ไม่เปลี่ยน focus และ scroll anchor ไม่ถูกแย่ง
4. Table/JSON view ตรงกับ metadata จริง; repeated/unmatched/malformed/truncated spans ไม่ทำ output หาย ข้อความ HTML/script คง inert
5. Cover error-without-details, cell/ACP disagreement, empty/image-only output, field limits, replay/no observed time, lane switch, eviction และ last-reported background snapshot
6. รัน `npm run check`, focused parser/retention/component/Harness tests และ CSS ownership suite หลังแก้ครบ Permanent tests ตรวจ behavior/invariants ไม่ pin wording หรือ source text
7. Browser smoke ใช้ captured/locally produced ACP fixtures ผ่าน client→view→real components ตรวจ layout 390/900/1440, computed hidden/display, selection/scroll, keyboard, final seal ไม่มี DOM writes จาก timer แล้วตรวจ native WKWebView focus/copy เมื่อ runtime เข้าถึงได้ แยกข้อจำกัดที่ไม่ได้พิสูจน์
8. ตรวจบน **Harness จริง** โดยวาง Inspector ข้าง generic ToolRow, assistant row และ GenUI card เปรียบเทียบ screenshot กับ computed styles ที่ width/font scale เดียวกัน: `krypton-dark`, `krypton-light`, `legacy-radiance` และ custom theme ที่ override accent/foreground/font; ตรวจ live theme switch โดยไม่ reload ไม่มี dark syntax slab, สีอ่านไม่ออก หรือ style เปลี่ยนใน sibling rows
9. ตรวจ focus/hover, inherited font scaling, 390/900/1440 layout และ reduced motion พร้อม CSS ownership suite ห้ามใช้ภาพ HTML artifact เป็นหลักฐานว่าเข้ากับ Harness แล้ว; style regression ของ surface เดิมต้องแก้ก่อนถือว่า feature เสร็จ

### Implementation smoke — 2026-10-20

- `npm run check` และ `npm run build` ผ่านทั้ง app/GenUI gallery; focused suites ผ่าน 439 tests ใน 10 files และตรวจซ้ำ 23 tests ของ panel/integration/CSS หลังแก้ WebKit focus และเพิ่ม sibling invariant Build มี warnings เรื่อง third-party directives, mixed imports และ large chunks
- Chrome ใช้ `AcpClient` → `AcpHarnessView` → components จริง กับ captured OMP `18.12.3` frames และ local edge fixtures; Tauri IPC เป็น local stub ไม่ได้เรียก GitHub หรือ model ภายนอก
- Live switch `krypton-dark`, `krypton-light`, `legacy-radiance`, custom foreground/accent/font ที่ viewport 390/900/1440: font/foreground ของ card ตรง generic ToolRow, background โปร่งใส, ไม่มี page-level horizontal overflow หรือปุ่มออกนอก panel แก้ controls ให้ wrap เมื่อพื้นที่แคบและใช้ font 17px; sidebar เดิมของ Harness ไม่ถูกเปลี่ยน
- ตรวจ source/output/control node identity, selection `line-000`, scrollTop 80 หลัง append และ bottom gap 0 เมื่อ follow; ไม่มี idle DOM writes หรือ infinite animations หลัง sealed row จบ entrance เดิม
- ตรวจ `f` hint, Code disclosure, Tab/Enter/Escape, clipboard, error-without-details, terminal-only replay, ACP/cell disagreement, background snapshot, hidden tab, lane switch และ focus-safe eviction; HTML/script ใน output ไม่ execute
- Native `WKWebView` โหลด Harness ชุดเดียวกันผ่าน local Vite: trusted pointer event กด Copy, source ที่มีค่าเฉพาะแต่ละ run ตรง `NSPasteboard`, focus คงบนปุ่ม แล้ว native Escape ปิด panel/คืน composer สำเร็จ ทดสอบเจอและแก้ default mouse focus reset ของ WebKit
- Native probe นี้ไม่ใช่การเปิด packaged Tauri app หรือ full workspace/compositor smoke; ไม่อ้างว่าได้ทดสอบ bundle install หรือ runtime execution บนทุก backend

## Open Questions

ไม่มี prerequisite ที่ค้างสำหรับ scope นี้ Shape recognition เป็นข้อจำกัดที่อนุมัติแล้ว: current ACP ไม่ยืนยัน canonical tool name และ Inspector ไม่เพิ่ม execution controls หรือเปลี่ยน error semantics ของ OMP

## Out of Scope

Editable code, run/rerun/interrupt/retry, kernel/variables inspector, notebook document/cell counts, per-line tracing, inferred Waiting/progress, new nested-tool/subagent transcript, async job polling/settlement tracking, new telemetry/storage, new native window/browser surface, cross-backend execution adapters และการแก้ OMP identity/error behavior

## Resources

- [ACP v1 Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) — session-scoped toolCallId, optional name, partial updates และ standard statuses
- [JupyterLab — Working with cells](https://jupyterlab.readthedocs.io/en/stable/user/notebook.html#working-with-cells) — source/output disclosure และ scrolling
- [VS Code — Running cells](https://code.visualstudio.com/docs/datascience/jupyter-notebooks#running-cells) — code/output separation; execution/editor controls ที่ไม่นำเข้ามา
- OMP installed `18.12.3`, bundled [eval contract](omp://tools/eval.md), [extension provider contract](omp://extensions.md), และ isolated ACP smoke 2026-10-20 — authoritative field availability สำหรับเครื่องนี้
- `/Users/wk/Source/oh-my-pi/packages/coding-agent/src/modes/acp/acp-event-mapper.ts`, `tools/eval.ts` — source navigation เท่านั้น (`16.3.11`), ไม่ใช้ยืนยัน views/background ของ binary ปัจจุบัน
- Zed source ranges ใน Prior Art; [spec 235](./0235-harness-tool-output-palette.md), [spec 282](./0282-harness-subagent-cards.md), [spec 303](./0303-themeable-component-tokens.md) และ linked specs ด้านบน — rendering, boundary validation, ownership และ theme conventions ที่ใช้ต่อ
