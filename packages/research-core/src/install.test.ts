import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRlab } from './install';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-install-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('installRlab', () => {
  it('软链 binScript → targetDir/rlab', () => {
    const binScript = path.join(root, 'rlab.mjs');
    fs.writeFileSync(binScript, '#!/usr/bin/env node\n');
    const target = installRlab(binScript, path.join(root, 'bin'));
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readlinkSync(target)).toBe(binScript);
  });
  it('幂等:重复装覆盖、不报错', () => {
    const binScript = path.join(root, 'rlab.mjs');
    fs.writeFileSync(binScript, '#!/usr/bin/env node\n');
    const t1 = installRlab(binScript, path.join(root, 'bin'));
    const t2 = installRlab(binScript, path.join(root, 'bin'));
    expect(t2).toBe(t1);
  });
});
