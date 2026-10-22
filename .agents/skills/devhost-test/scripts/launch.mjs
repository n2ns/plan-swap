// Child process of run.mjs: loads the project config and one scenario, then runs it. Its output is filtered by run.mjs.
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, runScenario } from './lib.mjs';

const [configPath, scenarioPath, name, windowArg] = process.argv.slice(2);
const config = (await import(pathToFileURL(configPath))).default;
const mod = await import(pathToFileURL(scenarioPath));
const window = windowArg ? (([x, y, width, height]) => ({ x, y, width, height }))(windowArg.split(',').map(Number)) : undefined;
const report = await runScenario({ name, config, seed: mod.seed, scenario: mod.run, window, outDir: path.join(root, '.test-out', 'devhost', name) });
process.exit(report.failures.length ? 1 : 0);
