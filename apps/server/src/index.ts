import { loadConfig } from './config';
import { buildApp } from './app';
import { Tmux } from './lib/session/tmux';

async function main(): Promise<void> {
  const config = loadConfig();

  // 启动时探测 tmux 可用性，早失败早提示
  const tmux = new Tmux(config.tmuxSocket);
  if (!(await tmux.isAvailable())) {
    console.error('[remote-cc] 找不到 tmux，请先安装 tmux（会话引擎依赖它）。');
    process.exit(1);
  }

  const app = await buildApp(config);
  await app.listen({ port: config.port, host: config.host });
  console.log(`[remote-cc] 监听 http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('[remote-cc] 启动失败:', err);
  process.exit(1);
});
