// 生成 PWA 图标:深色 `>_`(终端提示符)+ 米色底,贴现有主题。
// 用法:在 apps/web 下 `node scripts/gen-icons.mjs`(需 devDependency: sharp)。
// 产物 PNG 会写入 apps/web/public/(已提交进库);改图后重跑即可覆盖。
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '..', 'public');
const ICONS = resolve(PUBLIC, 'icons');
mkdirSync(ICONS, { recursive: true });

const BG = '#f3efe6'; // 与 themes/tokens.css 的 --bg 一致
const INK = '#2a2622'; // 深色暖墨

// 画 `>_`:viewBox 512;chevron 在左、underscore 在右,整体居中。
// scale<1 时把字形整体缩小(maskable 安全区用)。
function svg(size, scale = 1) {
  const sw = 46; // 描边宽
  // 字形(围绕画布中心 256,256 大致对称布置)
  const glyph = `
    <polyline points="166,168 250,256 166,344" fill="none"
      stroke="${INK}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="292" y1="344" x2="392" y2="344"
      stroke="${INK}" stroke-width="${sw}" stroke-linecap="round"/>`;
  // 先把字形 bbox(x 166..392 → cx≈279;y 168..344 → cy≈256)平移回正中,再按 scale 缩放。
  const centered = `<g transform="translate(${256 - 279}, 0)">${glyph}</g>`;
  const scaled = `<g transform="translate(256,256) scale(${scale}) translate(-256,-256)">${centered}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${BG}"/>
    ${scaled}
  </svg>`;
}

async function out(name, size, scale) {
  const file = resolve(name.startsWith('icons/') ? PUBLIC : PUBLIC, name);
  await sharp(Buffer.from(svg(size, scale))).png().toFile(file);
  console.log('written', name, `${size}x${size}`, `scale=${scale}`);
}

await out('icons/icon-192.png', 192, 1);
await out('icons/icon-512.png', 512, 1);
// maskable:字形缩到中心安全区(约 78%),避免被圆形/方圆遮罩裁掉
await out('icons/icon-maskable-512.png', 512, 0.78);
await out('apple-touch-icon.png', 180, 1);
console.log('done');
