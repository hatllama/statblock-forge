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
  'js/engine/core.js',
  'js/engine/reactions.js',
  'js/engine/choose.js',
  'js/engine/ai-v1.js',
  'js/engine/ai-v2.js',
  'js/engine/ai-boss.js',
  'js/engine/ai-v2-turn.js',
  'js/engine/encounter.js',
  'js/engine/day.js',
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
  return process.env.V1TRAP && !from ? v1Trap(ctx.TacEngine) : ctx.TacEngine;
}

/* V1TRAP=1: the old AI must be unreachable with v2 on for the party and tiers for the monsters (docs/ai-v2.md, "Phase 6 step 1").
   Every run (runDay, monteCarlo) is forced to ai { party: 'v2', foes: 'tiers' }, and inside a run every old-AI-only method throws:
   the Sim methods js/engine/ai-v1.js defines, plus V1_ONLY (old-AI code that lives in other files). Sims a test builds by hand are
   not trapped (they test the old AI on purpose). tests/smoke.js applies the same trap to the page's engine. */
const V1_ONLY = ['reactBarbsOld', 'reactLuckyOld', 'reactShieldOld', 'surge'];
// V1TRAP=log: count the calls by caller instead of throwing, and print them when the process ends (finding them all in one run)
const LOG = process.env.V1TRAP === 'log' ? new Map() : null;
if (LOG) process.on('exit', () => { if (LOG.size) console.log('\nV1TRAP calls:\n' + Array.from(LOG).sort((p, q) => q[1] - p[1]).map(([k, n]) => '  ' + n + '  ' + k).join('\n')); else console.log('\nV1TRAP: no old-AI calls'); });
function v1Names() {
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  let before = null, names = null;
  for (const f of ENGINE_FILES) {
    if (f === 'js/engine/ai-v1.js') before = Object.keys(ctx.TacEngine._.Sim.prototype);
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    if (f === 'js/engine/ai-v1.js') names = Object.keys(ctx.TacEngine._.Sim.prototype).filter(k => before.indexOf(k) < 0);
  }
  return names.concat(V1_ONLY);
}
function v1Trap(T) {
  const names = v1Names(), proto = T.Sim.prototype;
  let on = 0;
  for (const k of names) {
    const f = proto[k];
    if (typeof f !== 'function') throw new Error('V1TRAP: no method ' + k);
    proto[k] = function () {
      if (on && LOG) { const at = (new Error().stack.split('\n')[2] || '').trim().replace(/^at /, ''); const u = arguments[0], who = k === 'rankSpells' && u && u.tpl ? ` [${u.isPC ? 'PC ai ' + u.ai : 'monster'}${u.actions.some(a => a.ext && a.ext.swallow) ? ', swallow' : ''}${u.actions.some(a => a.ext && a.ext.pool && a.type !== 'heal') ? ', dice pool' : ''}]` : '';
        const key = k + who + ' <- ' + at.replace(/\(.*[\\/]/, '(').replace(/:\d+\)$/, ')'); LOG.set(key, (LOG.get(key) || 0) + 1); }
      else if (on) throw new Error('V1TRAP: ' + k + ' called with v2 + tiers on');
      return f.apply(this, arguments);
    };
  }
  const force = fn => function (day, opts) {
    const args = [].slice.call(arguments);
    args[1] = Object.assign({}, opts, { ai: { party: 'v2', foes: 'tiers' } });
    on++;
    try { return fn.apply(this, args); } finally { on--; }
  };
  T.runDay = force(T.runDay); T.monteCarlo = force(T.monteCarlo);
  T.v1TrapNames = names;
  return T;
}

module.exports = { ENGINE_FILES, loadEngine, v1Trap };
