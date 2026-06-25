import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const outDir = join(tmpdir(), 'fund-valuation-frontend-tests');
await mkdir(outDir, { recursive: true });

async function importTsModule(relativePath, name, replacements = {}) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  let outputText = compiled.outputText;
  for (const [from, to] of Object.entries(replacements)) {
    outputText = outputText.replaceAll(from, to);
  }
  const outFile = join(outDir, `${name}.${Date.now()}.mjs`);
  await writeFile(outFile, outputText, 'utf8');
  return import(pathToFileURL(outFile).href);
}

const { futuresPriceComparable, shouldUseFuturesQuote } = await importTsModule(
  '../src/components/IndexCards.logic.ts',
  'IndexCards.logic',
);
const { globalFutureReferencePrice } = await importTsModule('../src/quoteMath.ts', 'quoteMath');
const quoteMathPath = join(outDir, `quoteMath-dep.${Date.now()}.mjs`);
const quoteMathSource = await readFile(new URL('../src/quoteMath.ts', import.meta.url), 'utf8');
const quoteMathCompiled = ts.transpileModule(quoteMathSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    strict: true,
  },
});
await writeFile(quoteMathPath, quoteMathCompiled.outputText, 'utf8');
const { parseSinaVar } = await importTsModule('../src/api.ts', 'api', {
  "from './quoteMath';": `from '${pathToFileURL(quoteMathPath).href}';`,
});
const now = Date.parse('2026-06-22T19:00:00+08:00');

assert.equal(
  futuresPriceComparable({ price: 30406, fetchedAt: now }, { price: 30723, fetchedAt: now }),
  true,
);
assert.equal(
  futuresPriceComparable({ price: 44946, fetchedAt: now }, { price: 73302, fetchedAt: now }),
  false,
);
assert.equal(
  shouldUseFuturesQuote({
    spot: { price: 44946, fetchedAt: now, dateReliable: false },
    futures: { price: 73302, fetchedAt: now },
    spotState: 'live',
    futuresState: 'live',
    now,
  }),
  false,
);
assert.equal(
  shouldUseFuturesQuote({
    spot: { price: 69404, fetchedAt: now, dateReliable: true },
    futures: { price: 69420, fetchedAt: now },
    spotState: 'closed',
    futuresState: 'live',
    now,
  }),
  true,
);
assert.equal(
  shouldUseFuturesQuote({
    spot: { price: 44946, fetchedAt: now, dateReliable: true },
    futures: { price: 73302, fetchedAt: now },
    spotState: 'closed',
    futuresState: 'live',
    now,
  }),
  false,
);
assert.equal(
  shouldUseFuturesQuote({
    spot: { price: 30406, fetchedAt: now, dateReliable: true },
    futures: { price: 30723, fetchedAt: now - 120_000 },
    spotState: 'closed',
    futuresState: 'live',
    now,
  }),
  false,
);
assert.equal(globalFutureReferencePrice('30719.750', '0.000', 30762.807), 30719.75);
assert.equal(globalFutureReferencePrice('23776.000', '23761.000', 23813.95), 23776);
assert.equal(globalFutureReferencePrice('75.850', '78.000', 75.111), 75.85);
{
  const parsed = parseSinaVar('var hq_str_hf_NQ="30209.010,,30203.500,30205.000,30263.750,29924.500,20:42:59,29514.250,30089.750,0,2,2,2026-06-25,纳斯达克指数期货,0";', now);
  assert.equal(parsed?.data.previousClose, 29514.25);
  assert.equal(parsed?.data.changePercent, 2.35);
}
{
  const parsed = parseSinaVar('var hq_str_hf_HSI="23090.000,,23089.000,23091.000,23090.000,22985.000,20:45:43,23026.000,23028.000,55321,1,2,2026-06-25,恒生指数期货,1729";', now);
  assert.equal(parsed?.data.previousClose, 23026);
  assert.equal(parsed?.data.changePercent, 0.28);
}
{
  const parsed = parseSinaVar('var hq_str_hf_NK="72589.900,,72575.000,72590.000,72670.000,72305.000,20:46:19,72400.000,72555.000,44245,3,4,2026-06-25,日经225指数期货,1943";', now);
  assert.equal(parsed?.data.previousClose, 72400);
  assert.equal(parsed?.data.changePercent, 0.26);
}
assert.equal(
  parseSinaVar('var hq_str_int_nikkei="日经指数,44946.64,-408.35,-0.90";', now),
  null,
);
assert.equal(
  parseSinaVar('var hq_str_int_nikkei="日经225,69404.50,87.00,0.13,2026-06-24,10:30:00";', now)?.data.price,
  69404.5,
);
assert.equal(
  parseSinaVar('var hq_str_s_sz399006="创业板指,4371.99,120.56,2.84,0,0,2026-06-25";', now)?.data.time,
  '2026-06-25',
);
{
  const parsed = parseSinaVar('var hq_str_sz159326="电网设备,0.000,2.189,0.000,0.000,0.000,0.000,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,2026-06-25,09:10:00,00";', now);
  assert.equal(parsed?.data.price, 2.19);
  assert.equal(parsed?.data.changePercent, 0);
}
assert.equal(
  parseSinaVar('var hq_str_s_sz399006="创业板指,0.00,0.00,0.00,0,0";', now),
  null,
);
assert.equal(
  parseSinaVar('var hq_str_hf_NQ="30209.010,,30203.500,30205.000,30263.750,29924.500,20:42:59,1.000,30089.750,0,2,2,2026-06-25,纳斯达克指数期货,0";', now),
  null,
);

console.log('frontend logic tests passed');
