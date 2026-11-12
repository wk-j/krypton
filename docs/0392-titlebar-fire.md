# Titlebar Fire — Implementation Spec

> Status: Implemented (2026-11-12), revised twice 2026-11-12
> Date: 2026-11-12
> Milestone: Window chrome
> Extends: [0390](./0390-header-band-progress.md), [0391](./0391-workspace-fire.md)

## Problem

ผู้ใช้ต้องการให้ fire ของแต่ละ window ไหม้ตามแนว progress band แล้วลอยขึ้นผ่าน titlebar ตอนนี้ fire อยู่เฉพาะด้านล่าง workspace ส่วน titlebar ยังเป็น plate ตามปกติ

รอบแรกวาง canvas คลุม chrome ทั้งแผ่น ไฟเลยฟุ้งเต็มความยาว titlebar รวมช่วง margin นอก band และ `overflow: hidden` ของ chrome ตัดเปลวไฟไว้ที่ขอบบนของ titlebar ผู้ใช้แก้ว่าไฟต้องอยู่เฉพาะช่วงความกว้างของ progress band ไม่ใช่ตลอดความยาว titlebar และต้องลอยทะลุ titlebar ขึ้นไปพ้นขอบบนของ window ไม่จำกัดอยู่ใต้ความสูงของ titlebar

รอบที่สองวางไฟไว้หลังเนื้อหาของ titlebar tab strip ซึ่งเป็นรางทึบจึงบังไฟเกือบทั้งช่วงที่มี tab ผู้ใช้แก้ว่าไฟต้องอยู่ชั้นบนสุด เหนือทุกอย่างใน titlebar รวมถึง tab

## Solution

window ที่เข้าเงื่อนไข `[fire] on` ได้ canvas หนึ่งอันใน `.krypton-window__chrome` กว้างเท่า `.krypton-window__header-accent` พอดี (ระหว่าง margin เดิมของ band) ขอบล่างของ canvas อยู่ที่ขอบล่างของ band และขอบบนยื่นขึ้นไปเหนือ chrome ไฟจึงเริ่มจาก band ลอยผ่าน titlebar แล้วพ้นขอบบนของ window ระหว่างที่ window มี canvas นี้ chrome จะได้ modifier `krypton-window__chrome--fire` ที่เปลี่ยน `overflow` เป็น `visible` ส่วนที่อยู่เหนือ window จึงไม่โดนตัด

workspace fire ยังอยู่ที่เดิม trigger และ look ใช้ของเดิม ไม่สร้าง fire จาก progress อย่างเดียว และไม่เพิ่ม config key

ไฟเป็นชั้นบนสุดของ chrome อยู่เหนือข้อความ, LED, tab strip, status, controls และ track/fill ของ band ไม่เพิ่มความสูงของ chrome และไม่ทับ terminal text ของ window ตัวเอง เพราะ canvas จบที่ขอบล่างของ band ระหว่างที่ไฟแสดง window ได้ modifier `krypton-window--fire` (`z-index: 1`) ที่ยก window ขึ้นเหนือ window อื่น (ซึ่งเป็น `z-index: auto`) ส่วนที่ลอยเหนือ window จึงทับ window ข้างบนเสมอ ไม่ขึ้นกับลำดับใน DOM overlay, Quick Terminal และ workspace footer ยังอยู่เหนือไฟ

progress band ใต้ titlebar ยังคง layout และ fill เต็มความสูงตาม 0390 ไม่แบ่งเป็นเส้น 2px แม้จะเป็นจุดกำเนิดไฟ fire และ progress มี lifetime แยกกัน

## Research

- `.krypton-window__chrome` มี `position: relative`, `z-index: 2` และ `overflow: hidden` titlebar มี `position: relative` กับ `z-index: 1` จึงเป็น stacking context ของตัวเอง ข้อความ, LED, tab strip และ controls ทั้งหมดอยู่ในนั้น canvas ที่ `z-index: 2` ใน chrome เดียวกันจึงอยู่เหนือทุกอย่างใน titlebar ไม่ว่าลูกของ titlebar จะตั้ง z-index เท่าไร band มี `position: relative` แต่ไม่มี z-index จึงอยู่ใต้ canvas ด้วย
- `.krypton-window` เป็น `position: absolute` และมี `transform` จาก layout จึงเป็น stacking context อยู่แล้ว window ใน grid/focus ไม่มี z-index (เป็น `auto`) ลำดับการวาดจึงตามลำดับใน DOM ถ้า window ที่ไหม้อยู่ก่อนใน DOM window ข้างบนที่มาทีหลังจะบังไฟ (เช่นหลัง swap) การให้ window ที่ไหม้เป็น `z-index: 1` แก้ได้โดยไม่กระทบ layout เพราะ grid/focus ไม่วาง window ทับกัน Quick Terminal (`5000`), hint overlay และ workspace footer (`9000`) กับ overlay อื่นยังสูงกว่า Stage layout ตั้ง `zIndex` เป็น inline style ซึ่งชนะ class จึงคงลำดับของ Stage ไว้
- `overflow: hidden` ของ chrome มาจาก commit `3034a27` ตอนเก็บ session mark ไว้ในราง titlebar แต่ titlebar กับ band ต่างมี `overflow: hidden` ของตัวเองอยู่แล้ว และ titlebar ไม่มี background (plate คือ background ของ chrome ซึ่งโค้งตาม `border-radius` เองโดยไม่ต้องพึ่ง overflow) การเปิด `overflow: visible` เฉพาะ chrome ที่มีไฟจึงไม่ทำให้อะไรในราง titlebar ล้นออกมา
- `.krypton-window` ใช้ `overflow: visible` อยู่แล้ว canvas ที่ยื่นเหนือ chrome จึงพ้นขอบบนของ window ได้โดยไม่ต้องย้ายออกไปนอก window และยังเคลื่อนตาม transform, WAAPI morph และ tilt ของ window ผ่าน DOM ตามปกติ
- `ProgressGauge.drawBand()` เป็นเจ้าของ `.krypton-window__header-progress`, modifiers และ `scaleX()`; `clearBand()` ลบเฉพาะ fill การวาง fire canvas เป็น child ของ chrome จึงไม่ต้องแก้ progress renderer หรือ CSS ของ progress
- `FireController.sync()` รับสถานะรวมของแต่ละ window และ content-view trigger แล้วใช้ `fireLookState()` กรอง `[fire] on` ส่วน workspace ใช้สถานะที่มี priority สูงสุดจาก window ที่กำลังไหม้
- `FireAnimation` ใช้ WebGL2 หนึ่ง context, heat envelope, look easing และ reduced motion ถ้าสร้าง instance ต่อ header จำนวน context จะเพิ่มตาม window และเสี่ยงชนข้อจำกัด WebKit ที่ spec 0362 บันทึกไว้
- shader วาด host เป็น rounded rect ใต้ขอบล่างของภาพ เปลวไฟลอยขึ้นจากขอบบนของ rect นั้นเต็มความกว้างของภาพ ถ้า canvas กว้างเท่า band และขอบล่างตรงกับ band ก็ใช้ geometry เดิมของ shader ได้เลยแบบ 1:1 uniform ตำแหน่งต้นกำเนิดไฟ (`u_origin`) ที่รอบแรกเพิ่มไว้จึงไม่จำเป็นและเอาออกแล้ว `fire-shader.ts` กลับเป็นเหมือน 0391
- `u_radius` ทำให้เปลวไฟลดความสูงลงใกล้ปลาย rect แต่ glow (`bloom`) ยังฟุ้งออกด้านข้างจนโดนขอบ canvas ตัดเป็นเส้นตั้ง ภาพที่ลอยเหนือ window จึงดูเป็นกล่อง ใช้ CSS mask แบบ static ให้ปลายทั้งสองข้างจางลงแทน ไม่มีต้นทุนต่อ frame
- header oscilloscope เดิมถูกถอดเพราะ WebKit repaint chrome ทุก frame ต้องตรวจ compositing จริง ไม่ถือว่า canvas ขนาดเล็กแปลว่าต้นทุนต่ำเสมอ

## Prior Art

| App | รูปแบบ | ข้อแตกต่าง |
|---|---|---|
| Ghostty | `custom-shader` ประมวลผลภาพ terminal ทั้ง surface; animation ตามปกติทำงานเฉพาะ surface ที่ focus | ไม่ใช่ fire บน titlebar |
| Krypton | shader fire ตาม program status และ `tool_error`; header progress ใช้แถบใต้ titlebar | เพิ่ม fire ตามแนว band ที่ลอยผ่าน titlebar โดยคง progress แยกพื้นที่ |

ไม่พบตัวอย่างตรงกันในแหล่งที่ตรวจ Krypton ไม่วางไฟทับ terminal text ของ window ที่ไหม้

## Affected Files

| File | งาน |
|---|---|
| `src/fire.ts` | `FirePainter` ใช้ร่วมกัน; `titlebarFireBand()`; `TitlebarFires` วาง canvas ตาม band, ตั้ง chrome modifier, ตั้ง window modifier ตามการแสดงของ canvas, ขยายหรือหด canvas ตาม look height และต่อเข้ากับ controller เดิม |
| `src/compositor.ts` | ส่ง titlebar เข้า fire sync; รักษา remove/resize/config lifecycle |
| `src/styles/window.css` | `.krypton-window__chrome--fire`, `.krypton-window--fire`, ตำแหน่งและ stacking ของ canvas, mask ปลาย band |
| `src/fire-controller.test.ts` | regression tests ของความกว้างตาม band, ขอบล่าง, ส่วนที่ยื่นเหนือ window, stacking เหนือ titlebar, การยก window, look height, สถานะ window, host replacement, cleanup, progress และ context restore |
| `DESIGN.md` | ระบุ titlebar fire เป็นส่วนขยายของ config effect เดิม |
| `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0006-configuration.md` | อธิบายตำแหน่ง fire เพิ่มเติม โดยไม่เปลี่ยน config syntax |
| `docs/0390-header-band-progress.md`, `docs/0391-workspace-fire.md`, `docs/README.md` | เชื่อม spec และแก้ข้อจำกัดเดิมเรื่อง canvas บน window |

`src/fire-shader.ts` ไม่เปลี่ยน

## Design

### State และ API

ขยาย `FireController.sync(windowId, state, trigger, titlebar)` ให้รับ `HTMLElement | null` ของ titlebar สถานะ fire ยังคำนวณครั้งเดียวด้วย `fireLookState()`; titlebar ใช้ look ของ window นั้น ส่วน workspace ใช้ priority รวมตาม 0391

titlebar renderer เก็บ titlebar host, chrome, band, `.krypton-window` ที่เป็นเจ้าของ chrome, ขอบซ้าย ความกว้าง และขอบล่างของ band (พิกัด chrome), ขนาด canvas, seed, look และ heat ของแต่ละ window ไม่อ่าน DOM ของ transcript และไม่แก้ sealed rows

### Geometry

`titlebarFireBand(bandWidth, baseline, height)` คืนขนาด canvas โดย `baseline` คือระยะจากขอบบนของ chrome ถึงขอบล่างของ band

- ความกว้าง = ความกว้างของ band
- เปลวไฟสูงสุด = `clamp(2 × baseline, 40, 120) × height` ค่า default (titlebar 36px + band 6px) ได้ 84px ซึ่งสูงกว่า chrome สองเท่า
- ความสูง canvas = `ceil(เปลวไฟสูงสุด × 2.2)` เหมือน `fireBand()` ของ workspace ให้ embers มีที่ลอย ค่า default ได้ 185px ขอบบนของ canvas จึงอยู่เหนือ window ราว 143px

canvas ใช้ `left = band.offsetLeft`, `top = baseline − ความสูง canvas` (ค่าติดลบ), `width` และ `height` ตามขนาดข้างบน backing store เท่ากับขนาด CSS วาดจาก scratch แบบ 1:1 ไม่ย่อขยาย ส่ง `u_radius = 12` ให้เปลวไฟลดความสูงลงช่วงท้าย band และ embers เริ่มห่างปลายเข้ามา CSS mask จางปลายทั้งสองข้าง 24px

เมื่อ look เปลี่ยนเป็นค่า `height` ที่สูงกว่า canvas ขยายทันที ถ้าต่ำกว่า canvas จะหดหลัง ease จบ (ใช้ `max(live.height, target.height)` แบบเดียวกับ workspace) การหดใน frame loop เขียน style และขนาด canvas อย่างเดียว ไม่อ่าน DOM

### Renderer และ lifecycle

- workspace ใช้ canvas เดิม เพิ่ม WebGL2 scratch canvas ที่ไม่แสดงอีกหนึ่งอันสำหรับ titlebar ทั้งหมด รวมสูงสุดสอง fire contexts ไม่ว่ามีกี่ window
- ใช้ shader และ GL draw code ร่วมกัน scratch กว้างเท่า canvas ที่กว้างที่สุดและสูงเท่า `max(64px, canvas ที่สูงที่สุด)` เปลี่ยน backing size เฉพาะเมื่อ layout หรือ look height เปลี่ยน
- แต่ละ window มี Canvas 2D สำหรับแสดงผล renderer วาด window หนึ่งลง scratch viewport แล้ว `drawImage()` ไปยัง canvas ของ window นั้นทันที ก่อนวาด window ถัดไป ไม่มี `getImageData()`, pixel loop, data URL หรือ ImageBitmap ที่สร้างใหม่ทุก frame
- titlebar ใช้ frame loop ร่วมกันหนึ่ง loop จำกัดที่ 60fps เก็บ buffer และรายการวาดไว้ใช้ซ้ำ ไม่วัด DOM และไม่ allocate ใน frame
- ResizeObserver ของ titlebar, chrome และ band อ่าน `offsetLeft`, `clientWidth` และ `offsetTop + clientHeight` ของ band ในพิกัด chrome ไม่ใช้ screen coordinates จึงตาม scale/tilt/occlusion ของ window ผ่าน DOM ได้ตามปกติ
- titlebar ที่ไม่มีพื้นที่หรือไม่แสดงไม่ต้องวาด IntersectionObserver ร่วมกับ document visibility หยุด loop เมื่อไม่มี titlebar ให้แสดงหรือ fade หมดแล้ว เมื่อกลับมาแสดงจะวาดสถานะล่าสุด
- สี, intensity, speed และ heat easing ใช้กติกาเดิม workspace embers ไม่เปลี่ยน
- reduced motion วาดภาพนิ่งเมื่อ state/look/size เปลี่ยน ไม่มี animation loop; stop ซ่อนทันที
- context loss หยุดและซ่อนเฉพาะ renderer ที่เสีย ไม่สร้าง context ทดแทนใน handler; restore สร้าง resources ใหม่ตาม lifecycle เดิม ถ้า init fail ให้ warning ครั้งเดียวและคง progress ปกติ
- window ปิด: unregister observers, ลบ canvas, เอา `krypton-window__chrome--fire` และ `krypton-window--fire` ออก และลบ state ทันที chrome จึงกลับไป clip ตามเดิม window ที่ไม่เคยไหม้ไม่มี canvas และไม่ได้ modifier; ปิด `[fire] on` แล้วไฟดับ loop หยุดหลัง fade

### Stacking และ progress

canvas เป็น child แรกของ chrome ที่ `z-index: 2` เหนือ titlebar (`z-index: 1`) และเหนือ track/fill ของ band จึงเป็นชั้นบนสุดของ chrome ข้อความ, tab และ controls ที่อยู่ใต้เปลวไฟจะอ่านยากขึ้นตามความสว่างของไฟ ซึ่งเป็นผลที่ผู้ใช้ขอ ใช้ `pointer-events: none` กับ `aria-hidden="true"` จึงไม่กระทบการคลิก tab การลาก และ keyboard

window ได้ `krypton-window--fire` เฉพาะตอนที่ canvas แสดงอยู่ (`display: block`) `TitlebarFires.show()` เปลี่ยน display ของ canvas กับ class ของ window พร้อมกันและเขียนเฉพาะเมื่อค่าเปลี่ยน ไม่ทำทุก frame canvas ถูกซ่อนเมื่อไฟ fade หมด, titlebar ออกนอกจอ, document ถูกซ่อน, context loss หรือ reduced motion ตอนดับไฟ class ก็หลุดตามไปด้วย window ที่ดับแล้วจึงกลับไปลำดับชั้นปกติ ส่วน `krypton-window__chrome--fire` ยังอยู่ตลอดที่ canvas ยังเป็นลูกของ chrome

ไม่แก้ความสูง สี ความยาว `scaleX()` หรือ complete/fade/dismiss ของ progress band `progress_display = "ring"` ยังซ่อนเฉพาะ progress fill ไม่ซ่อน titlebar fire ทั้งสองส่วนมี lifetime แยกกัน

### Configuration และ keybindings

ไม่มี key หรือ shortcut ใหม่ fire เป็น config effect ตาม `[fire] on` เดิม `[fire] height` ปรับความสูงของไฟบน titlebar ด้วยตัวคูณเดียวกับ workspace Quick Terminal ไม่มี trigger ใหม่ content window อย่าง Harness ยังไหม้ได้ผ่าน `tool_error` เท่านั้นตาม 0365

## Verification

- targeted fire/progress tests และ TypeScript check
- browser smoke ด้วย production `FireController` และ shell CSS: หลาย window คนละสถานะ, window กว้างและแคบ, dark/light, ดับไฟ, จุดไฟใหม่, ปิด window
- ยืนยันว่าขอบซ้ายขวาของ canvas ตรงกับ band, ขอบล่างตรงกับขอบล่างของ band, เปลวไฟลอยพ้นขอบบนของ window, ปลายไฟจางไม่เป็นเส้นตั้ง, ไฟอยู่เหนือข้อความและ tab strip ใน titlebar และไฟที่ลอยเหนือ window ทับ window ข้างบนโดยไม่ขึ้นกับลำดับใน DOM
- profile WebKit: context count คงที่, loop หยุดเมื่อดับ/ซ่อน, canvas และ mask ไม่ทำให้ plate นอก chrome repaint ทุก frame การ copy จาก WebGL ไป Canvas 2D มีต้นทุน ต้องวัดจริง ไม่อ้างว่าเป็น zero-copy
- ลบ throwaway smoke page หลังตรวจ ไม่ build/install/relaunch แอปที่กำลังใช้สนทนาถ้าไม่มีคำสั่ง

## Implementation Notes

- `FirePainter` ใช้ร่วมกันระหว่าง workspace และ `TitlebarFires` แต่ละ renderer มี context และ lifecycle ของตัวเอง `FireController.dispose()` ล้างทั้งสองส่วน
- รอบแก้ (2026-11-12): เปลี่ยนจาก canvas เต็ม chrome กับ uniform `u_origin` เป็น canvas ที่กว้างเท่า band และยื่นเหนือ chrome, เอา `u_origin` ออกจาก shader, เพิ่ม `titlebarFireBand()`, chrome modifier, `u_radius = 12` และ mask 24px ที่ปลาย ลองรัศมี 32 แล้วปลายยังเป็นเส้นตั้งเพราะ glow โดนตัด จึงใช้ mask
- workspace context restore จำสถานะที่ดับแล้วติดใหม่ระหว่าง context loss และเริ่มด้วย look ล่าสุด มี regression test
- รอบแก้ที่สอง (2026-11-12): canvas จาก `z-index: 0` เป็น `z-index: 2` ให้อยู่เหนือ titlebar ทั้งแถบรวม tab strip และ band, เพิ่ม `.krypton-window--fire { z-index: 1 }` กับ `TitlebarFires.show()` ที่ผูก class นี้กับการแสดงของ canvas, เอาข้อ "ยก z-index ของ window ที่ไหม้" ออกจาก Out of Scope

### ผลตรวจที่รัน (รอบแก้แรก)

- `npx vitest run src/fire.test.ts src/fire-controller.test.ts src/progress-gauge.test.ts` ผ่าน 39 tests และ `npm run check` ผ่าน
- Chromium smoke ผ่าน `browse` บน throwaway Vite page ขนาด 1440×520 ใช้ production `FireController` กับ shell CSS และ markup ทดสอบ: window 900px มี band ที่ x 81 ถึง 939 canvas ก็อยู่ที่ x 81 ถึง 939 ขอบล่าง y 223 ตรงกับขอบล่างของ band ขอบบน y 38 (สูง 185px) เปลวไฟลอยพ้นขอบบนของ window ราว 60px window แคบ 380px ได้ผลแบบเดียวกัน
- chrome ที่มีไฟได้ `overflow: visible` ส่วน window ที่ไม่ไหม้ยังเป็น `hidden` หลัง `remove()` canvas หายและ chrome กลับเป็น `hidden` ดับไฟแล้ว canvas ซ่อน จุดไฟใหม่แสดงอีกครั้ง
- ตรวจภาพ dark และ light แล้ว (ตอนนั้นไฟยังอยู่หลังข้อความ รอบแก้ที่สองเปลี่ยนเป็นไฟอยู่บนสุด) ข้อความใน titlebar อยู่เหนือไฟ ใน light scheme ตัวอักษรสีอ่อน (เช่น pty status) อ่านยากขึ้นเมื่ออยู่บนเปลวไฟสว่าง ซึ่งเป็นผลของการวางไฟหลังข้อความแบบเดิม
- ลบ throwaway page และปิด smoke session/dev server หลังตรวจ

### ผลตรวจที่รัน (รอบแก้ที่สอง)

- `npx vitest run src/fire.test.ts src/fire-controller.test.ts src/progress-gauge.test.ts src/styles/stylesheets.test.ts` ผ่าน 41 tests และ `npm run check` ผ่าน test ใหม่อ่าน z-index จาก `window.css` จริง ลองเปลี่ยน canvas กลับเป็น `z-index: 0` แล้ว test fail ตามคาด (`expected 0 to be greater than 1`)
- Chromium smoke ผ่าน `browse` บน throwaway Vite page ขนาด 1240×700 ใช้ production `FireController` กับ `index.css` window ที่ไหม้มี tab 3 อัน อยู่ก่อนใน DOM และวางใต้ window อีกอันที่ไม่ไหม้: computed style ได้ canvas `z-index: 2`, titlebar `1`, window ที่ไหม้ `1` และ window ข้างบน `auto` ภาพแสดงเปลวไฟทับ tab strip และลอยทับ footer ของ window ข้างบน เมื่อตั้ง window ที่ไหม้กลับเป็น `z-index: auto` ชั่วคราว window ข้างบนบังไฟตามที่คาด
- ลบ throwaway page และปิด smoke session/dev server หลังตรวจ

### ข้อที่ยังไม่ยืนยัน

- native transparent WKWebView, WebKit repaint/compositing, ต้นทุนของ mask และการ copy ระหว่าง GL/2D ยังไม่ได้ profile ผล Chromium ไม่ยืนยันประสิทธิภาพบน WebKit
- smoke ไม่ได้ใช้ compositor ของแอปที่กำลังรัน จึงยังไม่ยืนยันใน WKWebView ว่า window ที่ยกขึ้นทำงานถูกกับ WAAPI morph, การลาก window ใน Move mode และ tab/focus switching แบบ end-to-end ไม่มี build/install/relaunch แอปในงานนี้

## Open Questions

ไม่มี ผู้ใช้อนุมัติให้ implement ระหว่างลงมือชี้แจงว่าไฟเริ่มจาก progress band รอบแก้แรกกำหนดว่าไฟกว้างเท่า band และลอยพ้นขอบบนของ window และรอบแก้ที่สองกำหนดว่าไฟต้องอยู่ชั้นบนสุดรวมถึงเหนือ tab โดยคง workspace fire และ progress layout/lifecycle เดิม

## Out of Scope

- ย้ายหรือลบ workspace fire
- fire ตาม lane busy/idle, OSC 9;4 เป็น trigger ใหม่ หรือ fire ที่ติดตลอด
- ไฟที่กว้างเกิน progress band, ไฟตามความยาวของ progress fill, หรือไฟบนขอบอื่นของ window
- ไฟทับ terminal text ของ window ที่ไหม้
- ไฟเหนือ overlay, Quick Terminal, workspace footer หรือเปลี่ยนลำดับ z-index ของ Stage layout
- smoke, heat haze หรือ CSS infinite animation
- WebGL context ต่อ window หรือเปลี่ยน terminal renderer

## Resources

- [Ghostty custom-shader](https://ghostty.org/docs/config/reference#custom-shader), [custom-shader-animation](https://ghostty.org/docs/config/reference#custom-shader-animation): ขอบเขต shader และ focus-gated animation
- [0362](./0362-program-status-fire.md), [0363](./0363-program-status-fire-look.md), [0365](./0365-harness-tool-error-fire.md): shader, look และ trigger เดิม
- [0390](./0390-header-band-progress.md), [0391](./0391-workspace-fire.md): band ownership, workspace fire และข้อจำกัด compositing
