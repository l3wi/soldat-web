import { importContent } from './importer.ts';
import { hashDirectory, stableJson } from './output.ts';
import { ContentError } from './errors.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('bun packages/content/src/cli.ts --base reference/base --out dist/content [--source reference/opensoldat] [--pins pins.json]\nbun packages/content/src/cli.ts --hash dist/content');
} else {
  try {
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!key || !['--base', '--out', '--source', '--pins', '--hash'].includes(key) || !value || value.startsWith('--'))
        throw new ContentError('CLI', `Unknown or incomplete option: ${key}`);
      options[key.slice(2)] = value;
    }
    if (options.hash) console.log(stableJson(await hashDirectory(options.hash)));
    else {
      if (!options.base || !options.out) throw new ContentError('CLI', '--base and --out are required');
      const result = await importContent({ base: options.base, out: options.out, source: options.source, pins: options.pins });
      console.log(stableJson(result));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
