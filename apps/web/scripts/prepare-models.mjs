import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const publicDir = new URL('../public/', import.meta.url)
await mkdir(new URL('models/', publicDir), {recursive:true})
const target = new URL('models/face_landmarker.task', publicDir)
const checksum = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'
let bytes = await readFile(target).catch(() => null)
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== checksum) {
  const response = await fetch('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task')
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`)
  bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Face model checksum mismatch')
  await writeFile(target,bytes)
}
await cp(new URL('../node_modules/@mediapipe/tasks-vision/wasm/',import.meta.url), new URL('wasm/',publicDir),{recursive:true})
console.log('Pinned face model verified; browser WASM assets are ready.')
