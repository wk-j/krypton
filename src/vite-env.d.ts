/// <reference types="vite/client" />
// Spec 301: component modules import their own stylesheet (`import './tool-row.css'`)
// and the kernel reads `import.meta.env.DEV`. Both need Vite's ambient types; before
// this file every DEV read had to go through a hand-written `import.meta` cast.
