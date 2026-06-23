import { runCli } from './runCli';

const { code, stdout } = runCli(process.argv.slice(2), process.cwd());
process.stdout.write(stdout);
process.exit(code);
