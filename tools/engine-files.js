/* The tactical engine's files, in load order: the one place the list lives.
   index.html has the same files in the same order as script tags (`npm test` checks it), and every Node script
   (tests/run.js, tests/flagoff-hash.js, tests/ai-compare.js, tests/verify-compare.js, tools/build-threat.js) loads the
   engine through loadEngine(). How the files share names is described at the top of js/engine/base.js. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const ENGINE_FILES = [
  'js/engine/base.js',
  'js/engine/grid.js',
  'js/engine/ai-v2-data.js',
  'js/engine/knowledge.js',
  'js/engine/tactical-engine.js',
];

/* Runs the engine in a fresh vm context, the way the browser runs the script tags, and returns TacEngine.
   from (optional) is another copy to play instead, for before/after comparisons: a folder holding a checkout of
   the repo (its own tools/engine-files.js is read, so an older split works), or one file (an engine from before the split). */
function loadEngine(from) {
  let files;
  if (!from) files = ENGINE_FILES.map(f => [f, path.join(ROOT, f)]);
  else if (fs.statSync(from).isDirectory()) {
    const own = path.join(from, 'tools', 'engine-files.js');
    const list = fs.existsSync(own) ? require(path.resolve(own)).ENGINE_FILES : ['js/engine/tactical-engine.js'];
    files = list.map(f => [f, path.join(from, f)]);
  } else files = [['engine', from]];
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const [name, file] of files) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: name });
  if (!ctx.TacEngine || !ctx.TacEngine.runDay) throw new Error('the engine files did not define TacEngine');
  return ctx.TacEngine;
}

module.exports = { ENGINE_FILES, loadEngine };
