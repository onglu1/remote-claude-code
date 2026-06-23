import fs from 'node:fs';
import path from 'node:path';

/** 幂等软链 binScript → targetDir/rlab。返回 target 路径。 */
export function installRlab(binScript: string, targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    fs.chmodSync(binScript, 0o755);
  } catch {
    /* 测试占位脚本可能无权限,忽略 */
  }
  const target = path.join(targetDir, 'rlab');
  try {
    fs.lstatSync(target);
    fs.unlinkSync(target); // 已存在则先删(幂等)
  } catch {
    /* 不存在 */
  }
  fs.symlinkSync(binScript, target);
  return target;
}
