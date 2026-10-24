(function(){
'use strict';

const CELL = 36;
const SETUP_LABEL = '<b>Setup</b>: drag tokens to place them, click one to inspect it';
const SLOT_NAMES = {0:'action',1:'bonus',2:'legendary',3:'lair',4:'reaction',5:'other',6:'other','-1':'on 0 HP','-2':'on kill','-3':'pre-fight'};

/* ---------------- persistence (Claude storage, or the browser) ---------------- */
const SAVE_KEY = 'war-table-v1';
const store = {
  kind: (typeof window.storage !== 'undefined' && window.storage && typeof window.storage.get === 'function') ? 'claude'
      : (()=>{ try{ localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return 'local'; }catch(e){ return 'none'; } })(),
  async get(){ if(this.kind==='claude'){ try{ const r = await window.storage.get(SAVE_KEY,false); return r ? r.value : null; }catch(e){ return null; } }
               if(this.kind==='local'){ try{ return localStorage.getItem(SAVE_KEY); }catch(e){ return null; } } return null; },
  async set(v){ if(this.kind==='claude'){ const r = await window.storage.set(SAVE_KEY,v,false); if(!r) throw new Error('refused'); return; }
                if(this.kind==='local'){ localStorage.setItem(SAVE_KEY,v); return; } throw new Error('none'); },
};
let saveTimer = null, ready = false;
function scheduleSave(){
  if(!ready) return;
  const el = document.getElementById('wt-saveStatus');
  if(store.kind === 'none'){ el.textContent = 'Not saving here'; return; }
  el.className = 'save'; el.textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    try{ await store.set(JSON.stringify({ layouts: S.layouts, settings: S.settings, enc: S.enc }));
         el.className = 'save ok'; el.textContent = '✓ Saved'; }
    catch(e){ el.textContent = 'Save failed'; }
  }, 500);
}

/* ---------------- state ---------------- */
const S = {
  // the day is the Forge's own party and encounters, live
  get day(){ return { name: (document.getElementById('dayNameInput') || {}).value || 'Adventuring Day', players: PARTY_PLAYERS, encounters: encounters }; },
  enc: 0,
  layouts: {},                       // encIndex -> { gapFt, positions: {key:{x,y}} }
  settings: { surprise: '2024', escape: 'smart', runs: 500, map: '24x16', partyAI: 'tactical', tpkKills: false, climbDC: 10, knowParty: 'learn', knowFoes: 'open', morale: 'off', aiParty: 'v1', aiFoes: 'v1', settingsVer: 2 },
  mode: 'setup',
  odds: {},                          // encIndex -> summary
  replay: null,                      // { events, frames, units, idx }
};
const W = () => +S.settings.map.split('x')[0];
const H = () => +S.settings.map.split('x')[1];
const realEncounters = () => (S.day.encounters || []).map((e,i)=>({e,i})).filter(x=>x.e.monsters && x.e.monsters.length);
const layoutFor = i => (S.layouts[i] = S.layouts[i] || { gapFt: 30, positions: {} });
const simOpts = () => ({ width: W(), height: H(), surpriseRules: S.settings.surprise, escapePolicy: S.settings.escape, partyAI: S.settings.partyAI, tpkKills: !!S.settings.tpkKills,
  know: { party: S.settings.knowParty || 'learn', foes: S.settings.knowFoes || 'open' }, morale: S.settings.morale || 'off', ai: { party: S.settings.aiParty === 'v2' ? 'v2' : 'v1', foes: S.settings.aiFoes === 'v2' ? 'v2' : 'v1' }, climbDC: S.settings.climbDC === undefined ? 10 : +S.settings.climbDC,
  layouts: Object.fromEntries(Object.entries(S.layouts).map(([k,v])=>[k, v])) });
const esc = s => String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------------- encounter tabs ---------------- */
function renderTabs(){
  const el = document.getElementById('wt-encTabs');
  const list = realEncounters();
  if(!list.some(x=>x.i === S.enc) && list.length) S.enc = list[0].i;
  el.innerHTML = list.map((x,k)=>{
    const names = [...new Set(x.e.monsters.map(m=>`${m.name}${(m.count||1)>1?' ×'+m.count:''}`))].join(', ');
    return `<button class="tab ${x.i===S.enc?'active':''}" data-enc="${x.i}">${esc((x.e.name && String(x.e.name).trim()) || 'Encounter ' + (x.i+1))}<small>${esc(names)}</small></button>`;
  }).join('') || '<div class="empty">No monsters yet. Forge an encounter on the Forge page, or load a day file there, and it will appear here.</div>';
  el.querySelectorAll('[data-enc]').forEach(b=>b.onclick = ()=>{ stopPlay(); S.enc = +b.dataset.enc; S.replay = null; setMode('setup'); renderAll(); scheduleSave(); });
}

/* ---------------- board ---------------- */
const svg = document.getElementById('wt-board');
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent){ const e = document.createElementNS(NS, tag); for(const k in attrs) e.setAttribute(k, attrs[k]); if(parent) parent.appendChild(e); return e; }
function initials(name){
  const num = (name.match(/\s(\d+)$/)||[])[1] || '';
  const words = name.replace(/\s\d+$/,'').replace(/\(.*?\)/g,'').split(/[\s-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length-1][0] : (words[0]||'?').slice(0,2);
  return (letters.toUpperCase() + num).slice(0,4);
}
let tokenEls = {}, layers = {};
function buildBoard(units){
  svg.setAttribute('viewBox', `0 0 ${W()*CELL} ${H()*CELL}`);
  svg.innerHTML = '';
  tokenEls = {};
  const defs = el('defs', {}, svg);
  const pat = el('pattern', { id: 'wt-rough', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 8, height: 8, fill: 'rgba(110,150,90,.10)' }, pat);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: 'rgba(140,170,100,.6)', 'stroke-width': 2 }, pat);
  layers.terrain = el('g', {}, svg);
  const g = el('g', {}, svg);
  for(let x=0;x<=W();x++) el('line',{x1:x*CELL,y1:0,x2:x*CELL,y2:H()*CELL,class:'gridline'},g);
  for(let y=0;y<=H();y++) el('line',{x1:0,y1:y*CELL,x2:W()*CELL,y2:y*CELL,class:'gridline'},g);
  layers.terrainTop = el('g', { 'pointer-events': 'none' }, svg);
  layers.auras = el('g', {}, svg);
  layers.areas = el('g', {}, svg);
  layers.links = el('g', {}, svg);
  layers.tokens = el('g', {}, svg);
  layers.fx = el('g', {}, svg);
  for(const u of units){
    const t = el('g', { class: 'tok', 'data-uid': u.uid }, layers.tokens);
    const big = u.size === 'Large' || u.size === 'Huge' || u.size === 'Gargantuan';
    const r = big ? 16.5 : 14;
    const fill = u.team === 'party' ? 'var(--party)' : 'var(--foe)';
    const ink = u.team === 'party' ? 'var(--party-ink)' : 'var(--foe-ink)';
    el('circle', { r: r+7, class: 'halo', fill: 'rgba(207,219,138,.10)', stroke: '#cfdb8a', 'stroke-width': 2.5 }, t);
    el('circle', { r: r+2.5, fill: 'none', stroke: '#040201', 'stroke-width': 3.5 }, t);
    const ring = el('circle', { r: r+2.5, fill: 'none', stroke: '#6fc28f', 'stroke-width': 3, transform: 'rotate(-90)', 'stroke-linecap': 'round' }, t);
    const body = el('circle', { r, fill, stroke: '#040201', 'stroke-width': 1.5 }, t);
    const txt = el('text', { class: 'ini', 'text-anchor': 'middle', dy: '3.5', fill: ink }, t); txt.textContent = initials(u.name);
    const badge = el('text', { class: 'ini', 'text-anchor': 'middle', y: -r-7, fill: '#d98a5f', 'font-size': 11 }, t);
    const shadow = el('ellipse', { cx: 0, cy: r+4, rx: r*.8, ry: 3.5, fill: 'rgba(0,0,0,.45)', style: 'display:none' }, t);
    const altTxt = el('text', { class: 'ini', 'text-anchor': 'middle', y: r+15, fill: '#9cc3e6', 'font-size': 10 }, t);
    const title = el('title', {}, t); title.textContent = u.name;
    const circ = 2 * Math.PI * (r+2.5);
    // passive auras: a dashed square (5e grid distances) that follows the creature
    const auras = (u.auras || []).map(a=>{
      const n = Math.round(a.r / 5), side = (2*n + 1) * CELL;
      const rect = el('rect', { width: side, height: side, rx: 6, fill: 'rgba(217,87,63,.06)', stroke: 'rgba(217,87,63,.7)', 'stroke-width': 1.5, 'stroke-dasharray': '6 5', 'pointer-events': 'none' }, layers.auras);
      const tt = el('title', {}, rect); tt.textContent = `${u.name}: ${a.name} (${a.r} ft aura)`;
      return { rect, n };
    });
    tokenEls[u.uid] = { g: t, ring, body, txt, badge, title, r, circ, unit: u, fill, auras, altTxt, shadow };
    ring.setAttribute('stroke-dasharray', `${circ} ${circ}`);
  }
}
function placeToken(uid, x, y){
  const t = tokenEls[uid]; if(!t) return;
  t.g.setAttribute('transform', `translate(${(x+.5)*CELL},${(y+.5)*CELL})`);
  for(const a of t.auras){ a.rect.setAttribute('x', (x - a.n) * CELL); a.rect.setAttribute('y', (y - a.n) * CELL); }
}
/* areas of effect: the squares an area covers, coloured by what it does, with the caster's origin marked */
function drawArea(e, strong){
  const g = el('g', { 'pointer-events': 'none' }, layers.areas);
  const col = e.harm === 'cond' ? '155,120,214' : '217,87,63';
  const cells = e.cells || [];
  const set = new Set(cells.map(c=>c[0]+','+c[1]));
  for(const [x,y] of cells) el('rect', { x: x*CELL + 1, y: y*CELL + 1, width: CELL - 2, height: CELL - 2, rx: 3, fill: `rgba(${col},${strong ? .34 : .2})` }, g);
  // outline only the outside edges of the shape
  let d = '';
  for(const [x,y] of cells){
    const X = x*CELL, Y = y*CELL;
    if(!set.has(x+','+(y-1))) d += `M${X},${Y}h${CELL}`;
    if(!set.has(x+','+(y+1))) d += `M${X},${Y+CELL}h${CELL}`;
    if(!set.has((x-1)+','+y)) d += `M${X},${Y}v${CELL}`;
    if(!set.has((x+1)+','+y)) d += `M${X+CELL},${Y}v${CELL}`;
  }
  if(d) el('path', { d, fill: 'none', stroke: `rgba(${col},.95)`, 'stroke-width': 2, 'stroke-linecap': 'square' }, g);
  if(e.shape === 'cone' || e.shape === 'line' || e.shape === 'cube'){
    // point from the caster towards where it was aimed
    const ox = (e.ox+.5)*CELL, oy = (e.oy+.5)*CELL, tx = (e.tx+.5)*CELL, ty = (e.ty+.5)*CELL;
    el('line', { x1: ox, y1: oy, x2: tx, y2: ty, stroke: `rgba(${col},.8)`, 'stroke-width': 1.5, 'stroke-dasharray': '3 4' }, g);
  } else if(e.shape === 'sphere'){
    el('circle', { cx: (e.tx+.5)*CELL, cy: (e.ty+.5)*CELL, r: 4, fill: `rgba(${col},.95)` }, g);
  }
  return g;
}
function drawZone(z){
  const g = el('g', { 'pointer-events': 'none' }, layers.areas);
  for(const [x,y] of z.cells || []){
    if(z.zkind === 'fog') el('rect', { x: x*CELL, y: y*CELL, width: CELL, height: CELL, fill: 'rgba(205,210,214,.55)' }, g);
    else if(z.zkind === 'dmg') el('rect', { x: x*CELL, y: y*CELL, width: CELL, height: CELL, fill: 'rgba(230,150,60,.26)' }, g);
    else { el('rect', { x: x*CELL, y: y*CELL, width: CELL, height: CELL, fill: 'rgba(110,160,80,.22)' }, g); el('rect', { x: x*CELL, y: y*CELL, width: CELL, height: CELL, fill: 'url(#wt-rough)' }, g); }
  }
  return g;
}
function paintToken(uid, st, maxHp, name){
  const t = tokenEls[uid]; if(!t) return;
  const frac = Math.max(0, Math.min(1, st.hp / maxHp));
  t.ring.setAttribute('stroke-dashoffset', String(t.circ * (1 - frac)));
  t.ring.setAttribute('stroke', frac > .5 ? '#6fc28f' : frac > .25 ? '#d9a24f' : '#d9573f');
  const gone = st.dead && t.unit.team === 'foes';
  t.g.style.display = (!st.onBoard && !st.dead) || gone ? 'none' : '';
  for(const a of t.auras) a.rect.style.display = st.dead || st.hp <= 0 || !st.onBoard ? 'none' : '';
  t.g.style.opacity = st.dead ? .35 : 1;
  t.body.setAttribute('fill', st.down || st.dead ? '#36352e' : t.fill);
  t.txt.textContent = st.dead ? '✕' : st.down ? (st.stable ? '✚' : `${st.ds}/${st.df}`) : initials(name);
  t.txt.setAttribute('fill', st.down || st.dead ? '#e4e1d2' : (t.unit.team === 'party' ? '#03130a' : '#fff1ea'));
  // flying height: a shadow under the token and the height in feet
  if(t.altTxt){ t.altTxt.textContent = st.alt && !st.dead ? `↑${st.alt} ft` : ''; t.shadow.style.display = st.alt && !st.dead ? '' : 'none'; }
  const flags = [];
  if(st.alt && !st.dead) flags.push(`flying ${st.alt} ft up`);
  if(st.conds && st.conds.length) flags.push(...st.conds);
  t.title.textContent = `${name} — ${Math.max(0,Math.round(st.hp))}/${maxHp} HP${st.temp?` (+${st.temp} temp)`:''}${st.down?(st.stable?' · stable':` · death saves ${st.ds}✓ ${st.df}✗`):''}${st.dead?' · dead':''}${flags.length?' · '+flags.join(', '):''}`;
}

/* ---------------- token inspector: click a token to see what it has ---------------- */
let inspectUid = null;
function inspect(uid){ inspectUid = inspectUid === uid ? null : uid; renderInspect(); }
const cap1 = x => String(x).charAt(0).toUpperCase() + String(x).slice(1);
const signed = n => (n >= 0 ? '+' : '') + n;
function renderInspect(){
  const box = document.getElementById('wt-inspect'); if(!box) return;
  for(const k in tokenEls) tokenEls[k].g.classList.toggle('picked', k === inspectUid);
  let u = null, st = null;
  if(inspectUid && S.mode === 'replay' && S.replay){ u = S.replay.units[inspectUid]; st = S.replay.frames[S.replay.idx][inspectUid]; }
  else if(inspectUid && S.mode === 'setup'){ u = preview.find(p=>p.uid === inspectUid); st = u && u.state; }
  if(!u || !st){ inspectUid = null; box.hidden = true; box.innerHTML = ''; return; }
  const sh = u.sheet || {};
  const hp = Math.max(0, Math.round(st.hp)), frac = Math.max(0, Math.min(1, st.hp / u.maxHp));
  const col = frac > .5 ? '#6fc28f' : frac > .25 ? '#d9a24f' : '#d9573f';
  const sub = [sh.ai ? cap1(sh.ai) + ' AI' : '', u.size, sh.type, sh.cr !== undefined && sh.cr !== '' && u.team === 'foes' ? 'CR ' + sh.cr : '', sh.build].filter(Boolean).join(' · ');
  // height: the ground it stands on plus how high it flies
  const ground = st.ground || 0, alt = st.alt || 0;
  const height = alt ? `flying ${alt} ft up${ground ? ` (${ground + alt} ft above the floor)` : ''}` : ground > 0 ? `on ${ground} ft high ground` : ground < 0 ? `in a ${-ground} ft dip` : 'ground level';
  const acNow = st.ac !== undefined ? st.ac : sh.ac;
  const stats = [
    `<span><b>HP</b>${hp}/${u.maxHp}${st.temp ? ` +${st.temp} temp` : ''}</span>`,
    `<span><b>AC</b>${acNow}${sh.ac !== undefined && acNow !== sh.ac ? ` (base ${sh.ac})` : ''}</span>`,
    `<span><b>Height</b>${height}</span>`,
    `<span><b>Speed</b>${sh.speed || 30} ft${sh.fly ? ` · fly ${sh.fly}` : ''}${sh.climb ? ` · climb ${sh.climb}` : ''}</span>`,
  ];
  const chips = [];
  if(st.fled) chips.push(`<span class="chip">${st.fled === 'surrendered' ? 'surrendered' : 'fled the fight'}</span>`);
  else if(st.dead) chips.push('<span class="chip bad">dead</span>');
  else if(st.down) chips.push(`<span class="chip bad">${st.stable ? 'down, stable' : `down · death saves ${st.ds}✓ ${st.df}✗`}</span>`);
  else if(st.hp < u.maxHp / 2) chips.push('<span class="chip bad">bloodied</span>');
  if(!st.onBoard && !st.dead) chips.push(`<span class="chip bad">${st.swallowedBy ? 'swallowed' : 'off the field'}</span>`);
  if(st.grappledBy) chips.push(`<span class="chip bad">grappled${S.replay && S.replay.units[st.grappledBy] ? ' by ' + esc(S.replay.units[st.grappledBy].name) : ''}</span>`);
  (st.conds || []).forEach(c=>chips.push(`<span class="chip ${/Advantage/.test(c) && !/is attacked/i.test(c) ? 'good' : 'bad'}">${esc(c)}</span>`));
  if(st.conc) chips.push(`<span class="chip cool">◈ concentrating: ${esc(st.conc)}</span>`);
  if(st.react === false) chips.push('<span class="chip">reaction used</span>');
  const effects = (st.buffs || []).map(b=>`<span class="ief">• <span style="color:var(--parchment)">${esc(b[0])}</span>${b[1] ? ` — ${esc(b[1])}` : ''} <i>(${esc(b[2])}${b[3] ? ', from ' + esc(b[3]) : ''})</i></span>`).join('');
  const res = [];
  if(st.slots) res.push(`<span class="chip cool">slots ${esc(st.slots)}</span>`);
  else if(sh.slots && S.mode === 'setup') res.push(`<span class="chip cool">slots ${esc(sh.slots)}</span>`);
  if(st.leg) res.push(`<span class="chip">legendary actions ${esc(st.leg)}</span>`);
  if(st.legRes) res.push(`<span class="chip">legendary resistance ${esc(st.legRes)}</span>`);
  if(st.luck) res.push(`<span class="chip">luck ${esc(st.luck)}</span>`);
  (st.uses || []).forEach(x=>res.push(`<span class="chip">${esc(x)}</span>`));
  const def = [];
  const m = sh.mods;
  if(m && m.immune && m.immune.length) def.push('immune: ' + m.immune.join(', '));
  if(m && m.resist && m.resist.length) def.push('resists: ' + m.resist.join(', '));
  if(m && m.vulnerable && m.vulnerable.length) def.push('vulnerable: ' + m.vulnerable.join(', '));
  if(sh.condImmune) def.push("can't be " + sh.condImmune.join(', '));
  const saves = sh.saves ? ['str','dex','con','int','wis','cha'].map(k=>`${k.toUpperCase()} ${signed(+sh.saves[k] || 0)}`).join(' · ') : (sh.saveBonus !== undefined ? `all ${signed(Math.round(sh.saveBonus))}` : '');
  box.className = 'inspect ' + u.team;
  box.innerHTML = `<div class="ih"><span class="in">${esc(u.name)}</span><span class="isub">${esc(sub)}</span><button class="mini-btn ix" data-close-inspect title="Close">✕</button></div>
    <div class="istats">${stats.join('')}</div>
    <div class="ihp"><div style="width:${frac*100}%;background:${col}"></div></div>
    <div class="irow"><b>Status</b>${chips.length ? chips.join('') : '<span class="chip good">fine</span>'}</div>
    ${effects ? `<div class="irow"><b>Effects</b>${effects}</div>` : ''}
    ${res.length ? `<div class="irow"><b>Resources</b>${res.join('')}</div>` : ''}
    ${def.length ? `<div class="irow"><b>Defences</b>${esc(def.join(' · '))}</div>` : ''}
    ${saves ? `<div class="irow"><b>Saves</b><span class="mono">${esc(saves)}</span></div>` : ''}`;
  box.hidden = false;
}
document.getElementById('wt-inspect').addEventListener('click', ev=>{ if(ev.target.closest('[data-close-inspect]')){ inspectUid = null; renderInspect(); } });
svg.addEventListener('click', ev=>{
  if(S.mode !== 'replay') return;
  const g = ev.target.closest('.tok'); if(g) inspect(g.dataset.uid);
});

/* ---------------- setup mode ---------------- */
let preview = [];
/* ---------------- terrain ---------------- */
let tool = 'move';
function drawTerrain(terrain){
  if(!layers.terrain) return;
  layers.terrain.innerHTML = ''; layers.terrainTop.innerHTML = '';
  const cells = (terrain && terrain.cells) || {};
  const H_ = (x,y)=>{ const c = cells[x+','+y]; return c && c.h ? c.h : 0; };
  let any = false;
  for(const k in cells){
    const [x,y] = k.split(',').map(Number); const c = cells[k];
    if(x >= W() || y >= H()) continue;
    any = true;
    const X = x*CELL, Y = y*CELL;
    if(c.h){
      const a = Math.min(.65, .12 + Math.abs(c.h) * .09);
      el('rect', { x: X, y: Y, width: CELL, height: CELL, fill: c.h > 0 ? `rgba(190,180,90,${a})` : `rgba(60,90,130,${a})` }, layers.terrain);
    }
    if(c.t === 'wall'){
      el('rect', { x: X+1, y: Y+1, width: CELL-2, height: CELL-2, rx: 2, fill: '#3a3d36', stroke: '#5b6157', 'stroke-width': 1.5 }, layers.terrain);
      el('path', { d: `M${X+4},${Y+CELL*.36}h${CELL-8}M${X+4},${Y+CELL*.68}h${CELL-8}M${X+CELL*.5},${Y+3}v${CELL*.33}M${X+CELL*.3},${Y+CELL*.36}v${CELL*.32}M${X+CELL*.7},${Y+CELL*.68}v${CELL*.3}`, stroke: '#2e2620', 'stroke-width': 1.5, fill: 'none' }, layers.terrain);
    } else if(c.t === 'difficult'){
      el('rect', { x: X, y: Y, width: CELL, height: CELL, fill: 'url(#wt-rough)' }, layers.terrain);
    } else if(c.t === 'cover'){
      el('rect', { x: X+4, y: Y+CELL*.32, width: CELL-8, height: CELL*.36, rx: 3, fill: '#6f6a4f', stroke: '#4a4635', 'stroke-width': 1.2 }, layers.terrain);
    }
    if(c.h){
      const t = el('text', { x: X+3, y: Y+11, class: 'ini', fill: c.h > 0 ? '#e2d98a' : '#a9c4e8', 'font-size': 9.5 }, layers.terrainTop);
      t.textContent = (c.h > 0 ? '+' : '') + c.h*5;
      // cliff edges between different heights
      [[1,0],[0,1]].forEach(([dx,dy])=>{
        const h2 = H_(x+dx, y+dy); if(h2 === c.h) return;
        const d = dx ? `M${X+CELL},${Y}v${CELL}` : `M${X},${Y+CELL}h${CELL}`;
        el('path', { d, stroke: '#d8cf7a', 'stroke-width': Math.min(4, 1 + Math.abs(h2 - c.h)), opacity: .8 }, layers.terrainTop);
      });
    }
  }
  // edges where flat ground meets a raised neighbour on its left/top
  for(const k in cells){
    const [x,y] = k.split(',').map(Number); const c = cells[k]; if(!c.h) continue;
    [[-1,0],[0,-1]].forEach(([dx,dy])=>{
      if(cells[(x+dx)+','+(y+dy)] && cells[(x+dx)+','+(y+dy)].h) return;
      const X = x*CELL, Y = y*CELL;
      el('path', { d: dx ? `M${X},${Y}v${CELL}` : `M${X},${Y}h${CELL}`, stroke: '#d8cf7a', 'stroke-width': Math.min(4, 1 + Math.abs(c.h)), opacity: .8 }, layers.terrainTop);
    });
  }
  const lg = document.getElementById('wt-terrainLegend'); if(lg) lg.style.display = any ? '' : 'none';
}
let painting = null;
function cellAt(ev){ const p = svgPoint(ev); return { x: Math.floor(p.x / CELL), y: Math.floor(p.y / CELL) }; }
function paintCell(x, y){
  if(x < 0 || y < 0 || x >= W() || y >= H()) return;
  const k = x + ',' + y;
  if(painting.done.has(k)) return;
  painting.done.add(k);
  const lay = layoutFor(S.enc);
  lay.terrain = lay.terrain || { cells: {} };
  const cells = lay.terrain.cells;
  const c = Object.assign({}, cells[k] || {});
  if(tool === 'erase'){ delete cells[k]; return; }
  if(tool === 'up') c.h = Math.min(24, (c.h || 0) + 1);
  else if(tool === 'down') c.h = Math.max(-4, (c.h || 0) - 1);
  else c.t = tool;
  if(!c.h) delete c.h;
  if(c.t || c.h) cells[k] = c; else delete cells[k];
}
document.getElementById('wt-tools').addEventListener('click', ev=>{
  const b = ev.target.closest('[data-tool]'); if(!b) return;
  tool = b.dataset.tool;
  document.querySelectorAll('#wt-tools [data-tool]').forEach(x=>x.classList.toggle('on', x === b));
  svg.classList.toggle('painting', tool !== 'move');
  document.getElementById('wt-modeLabel').innerHTML = tool === 'move' ? SETUP_LABEL : `<b>Setup</b>: painting ${esc(b.textContent.trim().toLowerCase())}`;
  document.getElementById('wt-toolHelp').textContent = tool === 'move' ? 'Pick a terrain tool to paint the map.' :
    tool === 'up' || tool === 'down' ? 'Each click or stroke changes the height by 5 ft. Going up costs 5 ft of movement per 5 ft of height. A 5-ft rise gives half cover to whoever is behind it; a ledge of 10 ft or more needs a climb speed or an Athletics check (up or down). Reach and sight follow the height. Flyers skip all of this: no climbing, no difficult ground, and they see over raised ground.' :
    tool === 'erase' ? 'Drag across squares to clear them.' : 'Click or drag across squares to paint.';
});
document.getElementById('wt-btnClearTerrain').onclick = ()=>{
  const lay = layoutFor(S.enc);
  if(!lay.terrain || !Object.keys(lay.terrain.cells || {}).length) return;
  if(!confirm('Clear all terrain on this encounter\'s map?')) return;
  delete lay.terrain; S.odds[S.enc] = null; renderOdds(); renderSetup(); scheduleSave();
};
function renderSetup(){
  const lay = layoutFor(S.enc);
  preview = TacEngine.previewPlacement(S.day, S.enc, lay, { width: W(), height: H() });
  buildBoard(preview);
  drawTerrain(lay.terrain);
  preview.forEach(u=>{ placeToken(u.uid, u.x, u.y); paintToken(u.uid, { hp: u.maxHp, onBoard: true, conds: [] }, u.maxHp, u.name); });
  svg.classList.add('setup');
  document.getElementById('wt-gap').value = lay.gapFt; document.getElementById('wt-gapVal').textContent = lay.gapFt + ' ft';
  const enc = S.day.encounters[S.enc] || {};
  document.getElementById('wt-nowLine').innerHTML = enc.playersSurprised ? '<span class="k">Ambush</span>The party is surprised in this encounter.' : enc.monstersSurprised ? '<span class="k">Ambush</span>The monsters are surprised in this encounter.' : '';
  document.getElementById('wt-roundBadge').textContent = '';
  renderInspect();
}
// dragging
let drag = null;
function svgPoint(ev){ const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); }
svg.addEventListener('pointerdown', ev=>{
  if(S.mode !== 'setup') return;
  if(tool !== 'move'){
    painting = { done: new Set() }; svg.setPointerCapture(ev.pointerId);
    const c = cellAt(ev); paintCell(c.x, c.y); drawTerrain(layoutFor(S.enc).terrain);
    return;
  }
  const g = ev.target.closest('.tok'); if(!g) return;
  const u = preview.find(p=>p.uid === g.dataset.uid); if(!u) return;
  drag = { u, g, x0: u.x, y0: u.y }; g.classList.add('dragging'); svg.setPointerCapture(ev.pointerId);
});
svg.addEventListener('pointermove', ev=>{
  if(painting){ const c = cellAt(ev); if(!painting.done.has(c.x + ',' + c.y)){ paintCell(c.x, c.y); drawTerrain(layoutFor(S.enc).terrain); } return; }
  if(!drag) return;
  const p = svgPoint(ev);
  placeToken(drag.u.uid, p.x / CELL - .5, p.y / CELL - .5);
});
svg.addEventListener('pointerup', ev=>{
  if(painting){ painting = null; S.odds[S.enc] = null; renderOdds(); renderSetup(); scheduleSave(); return; }
  if(!drag) return;
  const p = svgPoint(ev);
  const x = Math.max(0, Math.min(W()-1, Math.floor(p.x / CELL))), y = Math.max(0, Math.min(H()-1, Math.floor(p.y / CELL)));
  // a click without moving it: show what it is instead
  if(x === drag.x0 && y === drag.y0){ const uid = drag.u.uid; drag.g.classList.remove('dragging'); drag = null; placeToken(uid, x, y); inspect(uid); return; }
  const other = preview.find(o=>o !== drag.u && o.x === x && o.y === y);
  const lay = layoutFor(S.enc);
  if(other){ lay.positions[other.key] = { x: drag.u.x, y: drag.u.y }; }
  lay.positions[drag.u.key] = { x, y };
  drag.g.classList.remove('dragging'); drag = null;
  S.odds[S.enc] = null; renderOdds();
  renderSetup(); scheduleSave();
});

/* ---------------- running the odds ---------------- */
let running = false;
async function runOdds(){
  if(running) return;
  running = true;
  const n = +S.settings.runs, chunk = 20;
  const btn = document.getElementById('wt-btnRun'); btn.disabled = true;
  const prog = document.getElementById('wt-progress'); prog.style.display = 'block';
  const bar = prog.firstElementChild;
  const runs = [], base = (Date.now() & 0xffffff) + 1, opts = simOpts();
  for(let i=0;i<n;i+=chunk){
    for(let j=i;j<Math.min(n,i+chunk);j++){ const seed = (base + j * 7919) >>> 0; runs.push({ seed, res: TacEngine.runDay(S.day, Object.assign({}, opts, { seed })) }); }
    bar.style.width = (Math.min(n, i+chunk) / n * 100) + '%';
    document.getElementById('wt-runStatus').textContent = `Fighting… ${Math.min(n,i+chunk)} / ${n}`;
    await new Promise(r=>setTimeout(r, 0));
  }
  const summary = TacEngine.summarize(S.day, runs, opts);
  realEncounters().forEach(x=>S.odds[x.i] = summary);
  document.getElementById('wt-runStatus').textContent = `Simulated the whole day ${n} times.`;
  prog.style.display = 'none'; btn.disabled = false; running = false;
  renderOdds();
  document.getElementById('wt-oddsBlock').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pct(x, d){ return (x*100).toFixed(d === undefined ? 0 : d) + '%'; }
function renderOdds(){
  const box = document.getElementById('wt-odds');
  const sum = S.odds[S.enc];
  if(!sum){ box.innerHTML = '<div class="empty">Run the odds to see how this fight tends to go.</div>'; return; }
  const E = sum.encounters.find(e=>e.index === S.enc);
  if(!E || !E.fought){ box.innerHTML = '<div class="empty">The party never reached this encounter in the simulated days (an earlier fight was lost every time).</div>'; return; }
  const k = realEncounters().findIndex(x=>x.i === S.enc);
  const reachNote = E.fought < sum.n ? ` <small>· reached in ${pct(E.fought/sum.n)} of days</small>` : '';
  box.innerHTML = `
    <div class="tiles">
      <div class="tile ${E.winRate < .9 ? 'warn':''}"><div class="k">Party wins</div><div class="v">${pct(E.winRate, E.winRate>.99&&E.winRate<1?1:0)}${reachNote}</div></div>
      <div class="tile ${E.anyDeath > .05 ? 'warn':''}"><div class="k">A PC dies</div><div class="v">${pct(E.anyDeath, E.anyDeath<.1&&E.anyDeath>0?1:0)}</div></div>
      <div class="tile"><div class="k">Someone goes down</div><div class="v">${pct(E.anyDown)}</div></div>
      <div class="tile"><div class="k">Typical length</div><div class="v">${E.roundsMedian}<small> rounds</small></div></div>
      <div class="tile"><div class="k">Party HP left</div><div class="v">${pct(E.hpMedian)}<small> typical</small></div></div>
    </div>
    <div class="odds-grid">
      <div class="panel">
        <h4>Party HP at the end of the fight</h4>
        <div class="sub">How many of the ${E.fought} fights ended with this much of the party's total HP left. Bad nights are on the left.</div>
        <div class="hist" id="wt-hist"></div>
      </div>
      <div class="panel">
        <h4>Who's in danger</h4>
        <div class="sub">Per fight, across ${E.fought} simulated fights.</div>
        <table class="pcs"><tr><th></th><th>Goes down</th><th>Dies</th><th>Dmg dealt</th><th>Dmg taken</th></tr>
          ${E.pcs.map(p=>`<tr><td>${esc(p.name)}</td><td class="${p.downed>.25?'hot':''}">${pct(p.downed)}</td><td class="${p.died>.02?'hot':''}">${pct(p.died, p.died>0&&p.died<.1?1:0)}</td><td>${p.dealt.toFixed(0)}</td><td>${p.taken.toFixed(0)}</td></tr>`).join('')}
        </table>
      </div>
    </div>
    <div class="watch">
      <button class="primary-btn" data-watch="0.5">Watch a typical fight</button>
      <button class="ghost-btn" data-watch="0.1">Watch a bad one</button>
      <button class="ghost-btn" data-watch="0.9">Watch a good one</button>
      ${E.anyDeath > 0 ? '<button class="ghost-btn" data-watch="death">Watch one where a PC dies</button>' : ''}
    </div>
    ${k > 0 ? `<p class="help" style="margin-top:10px;">The party arrives with whatever HP and resources they had left after the earlier encounter${k > 1 ? 's' : ''}.</p>` : ''}`;
  drawHist(E);
  box.querySelectorAll('[data-watch]').forEach(b=>b.onclick = ()=>watchFrom(sum, b.dataset.watch));
}
function drawHist(E){
  const host = document.getElementById('wt-hist');
  const bins = E.hpHist, max = Math.max(1, ...bins);
  const w = 420, h = 170, pad = { l: 8, r: 8, t: 10, b: 24 };
  const bw = (w - pad.l - pad.r) / bins.length;
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Histogram of party HP left">`;
  s += `<line x1="${pad.l}" y1="${h-pad.b}" x2="${w-pad.r}" y2="${h-pad.b}" stroke="#2e231b"/>`;
  bins.forEach((c,i)=>{
    const bh = c / max * (h - pad.t - pad.b);
    const x = pad.l + i*bw + 1, y = h - pad.b - bh, ww = bw - 2;
    if(c > 0) s += `<path class="bar" data-i="${i}" d="M${x},${h-pad.b} V${y+Math.min(4,bh)} Q${x},${y} ${x+Math.min(4,ww/2)},${y} H${x+ww-Math.min(4,ww/2)} Q${x+ww},${y} ${x+ww},${y+Math.min(4,bh)} V${h-pad.b} Z"/>`;
    s += `<rect data-i="${i}" x="${pad.l+i*bw}" y="${pad.t}" width="${bw}" height="${h-pad.t-pad.b}" fill="transparent"/>`;
  });
  [0, 50, 100].forEach(v=>{ const x = pad.l + (w-pad.l-pad.r)*v/100; s += `<text class="axis" x="${x}" y="${h-6}" text-anchor="${v===0?'start':v===100?'end':'middle'}">${v}%</text>`; });
  s += `</svg><div class="tip" id="wt-histTip"></div>`;
  host.innerHTML = s;
  const tip = host.querySelector('#wt-histTip');
  host.querySelectorAll('[data-i]').forEach(r=>{
    r.addEventListener('mousemove', ev=>{
      const i = +r.dataset.i, c = bins[i];
      host.querySelectorAll('.bar').forEach(b=>b.classList.toggle('hot', +b.dataset.i === i));
      tip.style.display = 'block';
      tip.innerHTML = `${i*10}–${i*10+10}% HP left · <b>${c}</b> fight${c===1?'':'s'} (${pct(c/E.fought)})`;
      const box = host.getBoundingClientRect();
      tip.style.left = Math.min(box.width - 190, ev.clientX - box.left + 12) + 'px'; tip.style.top = (ev.clientY - box.top - 34) + 'px';
    });
    r.addEventListener('mouseleave', ()=>{ tip.style.display = 'none'; host.querySelectorAll('.bar').forEach(b=>b.classList.remove('hot')); });
  });
}
function watchFrom(sum, which){
  const runs = sum.runs.filter(r=>r.encHp[S.enc] !== undefined);
  if(!runs.length) return;
  let pick;
  if(which === 'death'){
    const opts = TacEngine; // find a run where someone died in this encounter
    pick = runs.find(r=>{ const res = TacEngine.runDay(S.day, Object.assign({}, simOpts(), { seed: r.seed })); const k = res.findIndex(x=>x.index === S.enc); if(k<0) return false;
      const before = k ? new Set(res[k-1].party.filter(p=>!p.dead).map(p=>p.uid)) : null; return res[k].party.some(p=>p.dead && (!before || before.has(p.uid))); });
  } else {
    const q = +which;
    const sorted = runs.slice().sort((a,b)=>a.encHp[S.enc] - b.encHp[S.enc]);
    pick = sorted[Math.min(sorted.length-1, Math.floor(q * (sorted.length-1)))];
  }
  if(pick) startReplay(pick.seed);
}

/* ---------------- replay ---------------- */
function startReplay(seed){
  stopPlay();
  const res = TacEngine.runDay(S.day, Object.assign({}, simOpts(), { seed, record: true }));
  const r = res.find(x=>x.index === S.enc);
  if(!r){ document.getElementById('wt-runStatus').textContent = 'The party didn\'t survive long enough to reach this encounter in that run.'; return; }
  const frames = []; let cur = {};
  r.events.forEach(e=>{ cur = Object.assign({}, cur); for(const k in e.state) cur[k] = e.state[k]; frames.push(cur); });
  const units = {}; r.units.forEach(u=>units[u.uid] = u);
  // which area (if any) is still resolving at each step: from the 'aoe' line through the saves and effects it causes
  const AOE_TAIL = new Set(['save','effect','down','death','react','deathsave','trigger','fail','swallow','expel','heal','zone','zoneEnd']);
  const aoeAt = []; let open = -1;
  r.events.forEach((e,i)=>{ if(e.kind === 'aoe') open = i; else if(!AOE_TAIL.has(e.kind)) open = -1; aoeAt.push(open); });
  // lasting areas (Entangle's ground, Fog Cloud) that are up at each step
  const zonesAt = []; let live = [];
  r.events.forEach(e=>{ if(e.kind === 'zone') live = live.concat([e]); else if(e.kind === 'zoneEnd') live = live.filter(z=>z.zid !== e.zid); zonesAt.push(live); });
  S.replay = { events: r.events, frames, units, unitList: r.units, idx: 0, seed, won: r.won, aoeAt, zonesAt };
  setMode('replay');
  buildBoard(r.units);
  drawTerrain(layoutFor(S.enc).terrain);
  // zoom to the part of the map the fight actually uses
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  frames.forEach(f=>{ for(const k in f){ const st = f[k]; x0 = Math.min(x0, st.x); y0 = Math.min(y0, st.y); x1 = Math.max(x1, st.x); y1 = Math.max(y1, st.y); } });
  if(isFinite(x0)){
    const pad = 2, minW = 12, minH = 8;
    let cw = Math.max(minW, x1 - x0 + 1 + pad*2), ch = Math.max(minH, y1 - y0 + 1 + pad*2);
    if(cw / ch > 1.6) ch = Math.ceil(cw / 1.6); else if(cw / ch < 1.2) cw = Math.ceil(ch * 1.2);
    cw = Math.min(cw, W()); ch = Math.min(ch, H());
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    const vx = Math.max(0, Math.min(W() - cw, cx - cw/2)), vy = Math.max(0, Math.min(H() - ch, cy - ch/2));
    svg.setAttribute('viewBox', `${vx*CELL} ${vy*CELL} ${cw*CELL} ${ch*CELL}`);
  }
  renderLog();
  const sc = document.getElementById('wt-scrub'); sc.max = r.events.length - 1; sc.value = 0;
  showFrame(0);
  window.scrollTo({ top: document.getElementById('wt-boardCard').getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' });
  play();
}
function actorAt(idx){
  const ev = S.replay.events;
  for(let i=idx;i>=0;i--) if(ev[i].kind === 'turn') return ev[i].uid;
  return null;
}
function showFrame(idx){
  const R = S.replay; R.idx = idx;
  const f = R.frames[idx];
  for(const uid in f){ const st = f[uid], u = R.units[uid]; if(!u) continue; placeToken(uid, st.x, st.y); paintToken(uid, st, u.maxHp, u.name); }
  // swallowed counts & grapple links
  layers.links.innerHTML = '';
  const inside = {};
  for(const uid in f){
    const st = f[uid];
    if(st.swallowedBy) inside[st.swallowedBy] = (inside[st.swallowedBy]||0) + 1;
    if(st.grappledBy && f[st.grappledBy]){ const g = f[st.grappledBy];
      el('line', { x1:(st.x+.5)*CELL, y1:(st.y+.5)*CELL, x2:(g.x+.5)*CELL, y2:(g.y+.5)*CELL, stroke:'#d9a24f', 'stroke-width':2, 'stroke-dasharray':'2 4', opacity:.8 }, layers.links); }
  }
  for(const uid in tokenEls) tokenEls[uid].badge.textContent = inside[uid] ? `◉ ${inside[uid]} inside` : '';
  layers.areas.innerHTML = '';
  if(R.zonesAt) R.zonesAt[idx].forEach(drawZone);
  if(R.aoeAt && R.aoeAt[idx] >= 0) drawArea(R.events[R.aoeAt[idx]], false);
  const actor = actorAt(idx);
  for(const uid in tokenEls) tokenEls[uid].g.classList.toggle('active', uid === actor);
  const e = R.events[idx];
  document.getElementById('wt-roundBadge').textContent = e.round > 0 ? `Round ${e.round}` : 'Initiative';
  document.getElementById('wt-nowLine').innerHTML = `<span class="k">${e.kind}</span>${esc(e.text)}`;
  document.getElementById('wt-scrub').value = idx;
  renderInit(f, actor);
  if(inspectUid) renderInspect();
  const logEl = document.getElementById('wt-log');
  logEl.querySelectorAll('.l').forEach(l=>{ const i = +l.dataset.i; l.classList.toggle('cur', i === idx); l.classList.toggle('future', i > idx); });
  const curL = logEl.querySelector(`.l[data-i="${idx}"]`);
  if(curL){ const top = curL.offsetTop - logEl.offsetTop; if(top < logEl.scrollTop || top > logEl.scrollTop + logEl.clientHeight - 30) logEl.scrollTop = top - logEl.clientHeight/2; }
}
function renderInit(f, actor){
  const R = S.replay;
  const order = (R.events[0] && R.events[0].order) || R.unitList.map(u=>u.uid);
  document.getElementById('wt-initList').innerHTML = order.map(uid=>{
    const u = R.units[uid], st = f[uid] || {}; if(!u) return '';
    const frac = Math.max(0, Math.min(1, (st.hp||0) / u.maxHp));
    const gone = st.dead || (!st.onBoard && !st.swallowedBy);
    const col = frac > .5 ? '#6fc28f' : frac > .25 ? '#d9a24f' : '#d9573f';
    const tag = st.dead ? 'dead' : st.down ? (st.stable ? 'stable' : `${st.ds}✓ ${st.df}✗`) : st.swallowedBy ? 'swallowed' : `${Math.round(st.hp)}/${u.maxHp}`;
    return `<div class="init-row ${uid===actor?'cur':''} ${gone?'gone':''}"><span class="dot" style="background:${u.team==='party'?'var(--party)':'var(--foe)'}"></span><span class="nm">${esc(u.name)}${st.slots || st.conc ? `<span class="spl">${st.slots ? 'slots ' + esc(st.slots) : ''}${st.conc ? ` · ◈ ${esc(st.conc)}` : ''}</span>` : ''}</span>
      <span><div class="mini-hp"><div style="width:${frac*100}%;background:${col}"></div></div><div class="mono" style="font-size:12px;color:var(--parchment-faint);text-align:right;">${tag}</div></span></div>`;
  }).join('');
}
function renderLog(){
  const R = S.replay;
  let html = '', round = -1;
  R.events.forEach((e,i)=>{
    if(e.kind === 'round'){ html += `<div class="r">Round ${e.round}</div>`; return; }
    if(e.kind === 'trigger') return;   // the effect it produces gets its own line
    if(e.round !== round && e.round === 0) html += `<div class="r">Before the fight</div>`;
    round = e.round;
    let cls = 'l';
    if(e.kind === 'turn') cls += ' t';
    else if(e.kind === 'death' || e.kind === 'down' || e.kind === 'swallow') cls += ' bad';
    else if(e.kind === 'heal') cls += ' good';
    else if(e.kind === 'intent') cls += ' why';
    else if(e.kind === 'aoe') cls += ' dmg';
    else if(e.kind === 'disengage' || e.kind === 'dash') cls += ' why';
    else if(e.dmg) cls += ' dmg';
    html += `<div class="${cls}" data-i="${i}">${esc(e.kind === 'turn' ? e.text.replace(/'s turn$/, '') : e.text)}</div>`;
  });
  const logEl = document.getElementById('wt-log');
  logEl.innerHTML = html;
  logEl.querySelectorAll('.l').forEach(l=>l.onclick = ()=>{ stopPlay(); showFrame(+l.dataset.i); });
}

/* animation */
let playing = false, playToken = 0;
const speed = () => +document.getElementById('wt-speed').value;
const wait = ms => new Promise(r=>setTimeout(r, ms / speed()));
function tween(uid, from, to, ms){
  return new Promise(res=>{
    const t0 = performance.now(), dur = ms / speed();
    const step = now=>{ const k = Math.min(1, (now - t0) / dur);
      placeToken(uid, from.x + (to.x - from.x)*k, from.y + (to.y - from.y)*k);
      if(k < 1) requestAnimationFrame(step); else res(); };
    requestAnimationFrame(step);
  });
}
function floater(x, y, text, color){
  const t = el('text', { x: (x+.5)*CELL, y: (y+.5)*CELL - 18, class: 'floater', fill: color, 'text-anchor': 'middle' }, layers.fx);
  t.textContent = text;
  const t0 = performance.now(), dur = 900 / speed();
  const step = now=>{ const k = Math.min(1, (now - t0) / dur); t.setAttribute('y', (y+.5)*CELL - 18 - k*18); t.setAttribute('opacity', 1 - k*k); if(k<1) requestAnimationFrame(step); else t.remove(); };
  requestAnimationFrame(step);
}
function strike(a, b, hit, ranged){
  const x1 = (a.x+.5)*CELL, y1 = (a.y+.5)*CELL, x2 = (b.x+.5)*CELL, y2 = (b.y+.5)*CELL;
  const line = el('line', { x1, y1, x2, y2, stroke: hit ? '#d9573f' : '#7d7866', 'stroke-width': ranged ? 2 : 3.5, 'stroke-linecap': 'round', 'stroke-dasharray': hit ? '' : '5 5', opacity: .9 }, layers.fx);
  setTimeout(()=>line.remove(), 420 / speed());
}
async function animateEvent(i){
  const R = S.replay, e = R.events[i], prev = R.frames[i-1] || R.frames[i];
  if(e.kind === 'move' && e.path && e.path.length){
    let p = e.from || prev[e.uid];
    for(const q of e.path){ await tween(e.uid, p, q, 110); p = q; }
    return;
  }
  if(e.kind === 'aoe'){
    layers.areas.innerHTML = '';
    const g = drawArea(e, true);
    const t0 = performance.now(), dur = 520 / speed();
    await new Promise(res=>{ const step = now=>{ const k = Math.min(1, (now - t0) / dur); g.setAttribute('opacity', String(k < .5 ? k*2 : 1 - (k-.5)*.6)); if(k < 1) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
    await wait(260); return;
  }
  const A = prev[e.uid], B = e.target ? (prev[e.target] || R.frames[i][e.target]) : null;
  const inArea = R.aoeAt && R.aoeAt[i] >= 0 && e.kind === 'save';
  if((e.kind === 'attack' || e.kind === 'save' || e.kind === 'react') && A && B && e.target){
    if(!inArea) strike(A, B, e.hit !== false, e.ranged);
    if(e.dmg) floater(B.x, B.y, (e.crit ? 'CRIT ' : '') + '-' + e.dmg, '#ff8a73');
    else if(e.kind === 'attack' && !e.hit) floater(B.x, B.y, 'miss', '#aca792');
    await wait(e.dmg ? 520 : 380); return;
  }
  if(e.kind === 'heal' && e.target && R.frames[i][e.target]){ const t = R.frames[i][e.target]; const m = e.text.match(/\+(\d+)/); floater(t.x, t.y, '+' + (m ? m[1] : ''), '#7fc08a'); await wait(420); return; }
  if(e.kind === 'digest' && e.dmg && R.frames[i][e.uid]){ const t = R.frames[i][e.uid]; floater(t.x, t.y, 'digesting', '#d98a5f'); await wait(380); return; }
  if(e.kind === 'turn' || e.kind === 'round'){ await wait(e.kind === 'round' ? 300 : 120); return; }
  await wait(['death','down','swallow','expel'].includes(e.kind) ? 520 : 260);
}
async function play(){
  if(!S.replay) return;
  if(S.replay.idx >= S.replay.events.length - 1) showFrame(0);
  playing = true; const my = ++playToken;
  document.getElementById('wt-btnPlay').textContent = '⏸';
  while(playing && my === playToken && S.replay && S.replay.idx < S.replay.events.length - 1){
    const i = S.replay.idx + 1;
    // show the line first, animate, then settle into the new state
    document.getElementById('wt-nowLine').innerHTML = `<span class="k">${S.replay.events[i].kind}</span>${esc(S.replay.events[i].text)}`;
    await animateEvent(i);
    if(my !== playToken) return;
    showFrame(i);
  }
  if(my === playToken) stopPlay();
}
function stopPlay(){ playing = false; playToken++; document.getElementById('wt-btnPlay').textContent = '▶'; }
document.getElementById('wt-btnPlay').onclick = ()=> playing ? stopPlay() : play();
document.getElementById('wt-btnStep').onclick = async ()=>{ stopPlay(); const R = S.replay; if(!R || R.idx >= R.events.length-1) return; const i = R.idx + 1; await animateEvent(i); showFrame(i); };
document.getElementById('wt-btnBack').onclick = ()=>{ stopPlay(); const R = S.replay; if(!R) return; showFrame(Math.max(0, R.idx - 1)); };
document.getElementById('wt-btnStart').onclick = ()=>{ stopPlay(); if(S.replay) showFrame(0); };
document.getElementById('wt-scrub').oninput = ev=>{ stopPlay(); showFrame(+ev.target.value); };
document.getElementById('wt-btnSetup').onclick = ()=>{ stopPlay(); S.replay = null; setMode('setup'); renderSetup(); };
document.addEventListener('keydown', ev=>{
  if(S.mode !== 'replay' || document.getElementById('viewWar').style.display === 'none' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if(ev.key === ' '){ ev.preventDefault(); playing ? stopPlay() : play(); }
  if(ev.key === 'ArrowRight') document.getElementById('wt-btnStep').click();
  if(ev.key === 'ArrowLeft') document.getElementById('wt-btnBack').click();
});

function setMode(m){
  S.mode = m;
  document.getElementById('wt-setupPanel').style.display = m === 'setup' ? '' : 'none';
  document.getElementById('wt-replayPanel').style.display = m === 'replay' ? '' : 'none';
  document.getElementById('wt-playControls').style.display = m === 'replay' ? '' : 'none';
  svg.classList.toggle('setup', m === 'setup');
  document.getElementById('wt-modeLabel').innerHTML = m === 'setup' ? (tool === 'move' ? SETUP_LABEL : document.getElementById('wt-modeLabel').innerHTML) :
    `<b>Replay</b> of run ${S.replay ? S.replay.seed : ''}${S.replay ? (S.replay.won ? ', the party wins' : ', the party loses') : ''}. Click a token to inspect it.`;
}
/* the setup card's tabs: Map, Rules, AI */
function showPane(name){
  if(!['map', 'rules', 'ai'].includes(name)) name = 'map';
  S.settings.sideTab = name;
  document.querySelectorAll('#wt-setupPanel .side-tabs [data-pane]').forEach(b=>{ b.classList.toggle('on', b.dataset.pane === name); b.setAttribute('aria-selected', b.dataset.pane === name ? 'true' : 'false'); });
  document.querySelectorAll('#wt-setupPanel .pane').forEach(p=>{ p.hidden = p.dataset.pane !== name; });
}
document.querySelector('#wt-setupPanel .side-tabs').addEventListener('click', ev=>{
  const b = ev.target.closest('[data-pane]'); if(!b) return;
  showPane(b.dataset.pane); scheduleSave();
});

/* ---------------- tactical stats ---------------- */
function renderStats(){
  const enc = S.day.encounters[S.enc] || { monsters: [] };
  const groups = [...(S.day.players||[]).map(c=>({c,team:'party'})), ...(enc.monsters||[]).map(c=>({c,team:'foes'}))];
  document.getElementById('wt-statsBody').innerHTML = groups.map(({c,team}, gi)=>{
    const ex = c.ext || {};
    const acts = (c.actions||[]).filter(a=>a.type !== 'template' || TacEngine.inferRange);
    return `<div class="cr"><div class="cr-head">
      <span class="cr-name ${team}">${esc(c.name)}${(c.count||1)>1?' ×'+c.count:''}</span>
      <label class="cr-field">Speed <input type="number" step="5" min="0" data-c="${gi}" data-f="speed" value="${ex.speed ?? ''}" placeholder="30"></label>
      <label class="cr-field">Init <input type="number" data-c="${gi}" data-f="initBonus" value="${ex.initBonus ?? ''}" placeholder="+0"></label>
      <label class="cr-field"><input type="checkbox" data-c="${gi}" data-f="initAdvantage" ${ex.initAdvantage?'checked':''}> Init adv.</label>
      <label class="cr-field" title="Can Disengage as a bonus action"><input type="checkbox" data-c="${gi}" data-f="bonusDisengage" ${(ex.bonusDisengage===true || (ex.bonusDisengage!==false && (c.actions||[]).some(a=>a.actionSlot===1&&/cunning action|nimble escape|disengage/i.test(a.name||''))))?'checked':''}> Bonus Disengage</label>
      <label class="cr-field">AI <select data-c="${gi}" data-f="ai" class="ai-sel">${[['auto', team==='party' ? 'Party setting' : 'Auto (' + TacEngine.autoAI(c) + ')'],['regular','Regular'],['tactical','Tactical'],['beast','Beast']].map(([v,l])=>`<option value="${v}" ${((ex.ai||'auto')===v)?'selected':''}>${l}</option>`).join('')}</select></label>
    </div><div class="acts">${acts.map((a,ai)=>{
      const fa = a.type === 'template' ? { ...a, name: a.templateOptions?.templateName || 'template', actionSlot: 4, target: 'self' } : a;
      const r = TacEngine.inferRange(fa);
      return `<div class="act"><span>${esc(fa.name || 'action')}<span class="slot">${SLOT_NAMES[fa.actionSlot] || ''}</span></span>
        <span><input type="number" step="5" min="0" class="${r.inferred?'auto':''}" data-c="${gi}" data-a="${ai}" value="${r.range}" title="${r.inferred?'Guessed from the name — type to set it':'Set in the day file'}"> ft</span></div>`; }).join('')}</div></div>`;
  }).join('');
  const body = document.getElementById('wt-statsBody');
  const creature = gi => groups[+gi].c;
  body.querySelectorAll('input[data-f]').forEach(inp=>inp.onchange = ()=>{
    const c = creature(inp.dataset.c); c.ext = c.ext || {};
    const f = inp.dataset.f;
    if(f === 'initAdvantage'){ if(inp.checked) c.ext[f] = true; else delete c.ext[f]; }
    else if(f === 'bonusDisengage'){ const named = (c.actions||[]).some(a=>a.actionSlot===1&&/cunning action|nimble escape|disengage/i.test(a.name||'')); if(inp.checked === named) delete c.ext[f]; else c.ext[f] = inp.checked; }
    else if(inp.value.trim() === '') delete c.ext[f]; else c.ext[f] = +inp.value;
    if(!Object.keys(c.ext).length) delete c.ext;
    changed();
  });
  body.querySelectorAll('select[data-f="ai"]').forEach(sel=>sel.onchange = ()=>{
    const c = creature(sel.dataset.c); c.ext = c.ext || {};
    if(sel.value === 'auto') delete c.ext.ai; else c.ext.ai = sel.value;
    if(!Object.keys(c.ext).length) delete c.ext;
    changed();
  });
  body.querySelectorAll('input[data-a]').forEach(inp=>inp.onchange = ()=>{
    const c = creature(inp.dataset.c), a = c.actions[+inp.dataset.a];
    a.ext = a.ext || {};
    if(inp.value.trim() === '') delete a.ext.range; else a.ext.range = Math.max(0, +inp.value);
    if(!Object.keys(a.ext).length) delete a.ext;
    inp.classList.remove('auto');
    changed();
  });
}
function changed(){
  S.odds = {}; renderOdds(); if(S.mode === 'setup') renderSetup(); scheduleSave();
  // the edit lives on the Forge's creature: refresh its cards and autosave
  try{ PARTY_PLAYERS.forEach(p=>p._warnings = validateMonster(p)); renderParty(); renderPartyBar(); renderMonsters(); refreshPreview(); }catch(e){}
}
/* ---------------- wiring ---------------- */
document.getElementById('wt-btnRun').onclick = runOdds;
document.getElementById('wt-btnOne').onclick = ()=> startReplay((Date.now() * 2654435761) >>> 0);
document.getElementById('wt-gap').oninput = ev=>{ const lay = layoutFor(S.enc); lay.gapFt = +ev.target.value; lay.positions = {}; document.getElementById('wt-gapVal').textContent = lay.gapFt + ' ft'; S.odds[S.enc] = null; renderOdds(); renderSetup(); scheduleSave(); };
document.getElementById('wt-btnReset').onclick = ()=>{ const lay = layoutFor(S.enc); lay.positions = {}; S.odds[S.enc] = null; renderOdds(); renderSetup(); scheduleSave(); };
document.getElementById('wt-mapSize').onchange = ev=>{ S.settings.map = ev.target.value; S.layouts = {}; S.odds = {}; renderOdds(); renderSetup(); scheduleSave(); };
document.getElementById('wt-surprise').onchange = ev=>{ S.settings.surprise = ev.target.value; S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-escape').onchange = ev=>{ S.settings.escape = ev.target.value; S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-climb').onchange = ev=>{ S.settings.climbDC = +ev.target.value; S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-tpk').onchange = ev=>{ S.settings.tpkKills = ev.target.checked; S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-partyAI').onchange = ev=>{ S.settings.partyAI = ev.target.value; S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-aiParty').onchange = ev=>{ S.settings.aiParty = ev.target.value; S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-aiFoes').onchange = ev=>{ S.settings.aiFoes = ev.target.value; S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-morale').onchange = ev=>{ S.settings.morale = ev.target.value; S.odds = {}; renderOdds(); scheduleSave(); };
const knowNote = ()=>{ document.getElementById('wt-learnWarn').style.display = (S.settings.knowParty === 'learn' || S.settings.knowFoes === 'learn') ? '' : 'none'; };
document.getElementById('wt-knowParty').onchange = ev=>{ S.settings.knowParty = ev.target.value; knowNote(); S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-knowFoes').onchange = ev=>{ S.settings.knowFoes = ev.target.value; knowNote(); S.odds = {}; renderOdds(); scheduleSave(); };
document.getElementById('wt-runs').onchange = ev=>{ S.settings.runs = +ev.target.value; scheduleSave(); };
function renderAll(){
  document.getElementById('wt-dayName').innerHTML = `${esc(S.day.name || 'Adventuring day')}<small>${(S.day.players||[]).length} party · ${realEncounters().length} encounter${realEncounters().length===1?'':'s'}</small>`;
  document.getElementById('wt-surprise').value = S.settings.surprise;
  document.getElementById('wt-escape').value = S.settings.escape;
  document.getElementById('wt-runs').value = String(S.settings.runs);
  document.getElementById('wt-partyAI').value = S.settings.partyAI || 'tactical';
  document.getElementById('wt-aiParty').value = S.settings.aiParty === 'v2' ? 'v2' : 'v1';
  document.getElementById('wt-aiFoes').value = S.settings.aiFoes === 'v2' ? 'v2' : 'v1';
  document.getElementById('wt-morale').value = S.settings.morale || 'off';
  document.getElementById('wt-knowParty').value = S.settings.knowParty || 'learn';
  document.getElementById('wt-knowFoes').value = S.settings.knowFoes || 'open';
  knowNote();
  showPane(S.settings.sideTab || 'map');
  document.getElementById('wt-tpk').checked = !!S.settings.tpkKills;
  document.getElementById('wt-climb').value = String(S.settings.climbDC === undefined ? 10 : S.settings.climbDC);
  document.getElementById('wt-mapSize').value = S.settings.map;
  renderTabs();
  if(S.mode === 'setup') renderSetup();
  renderOdds();
  renderStats();
}

let dayHash = '';
const hashDay = () => JSON.stringify(S.day, (k, v) => k === '_warnings' ? undefined : v);
// called whenever the War Table page is opened
function show(){
  const h = hashDay();
  if(h !== dayHash){
    // the party or encounters changed in the Forge: old odds and replays no longer apply
    dayHash = h; stopPlay(); S.odds = {}; S.replay = null;
    // positions saved for creatures that no longer exist are simply ignored
    setMode('setup');
  }
  renderAll();
  if(S.mode === 'replay' && S.replay) showFrame(S.replay.idx);
}
(async function init(){
  try{
    const raw = await store.get();
    if(raw){ const w = JSON.parse(raw); if(w.layouts) S.layouts = w.layouts; if(w.settings){ const old = !w.settings.settingsVer; Object.assign(S.settings, w.settings); if(old){ S.settings.knowParty = 'learn'; S.settings.settingsVer = 2; } } if(typeof w.enc === 'number') S.enc = w.enc; }
  }catch(e){}
  ready = true;
  setMode('setup');
})();
/* for the Forge: the settings and map one encounter is fought on (quick odds), and jumping straight to it */
function simOptsFor(i){
  const o = simOpts();
  o.layouts = S.layouts[i] ? { [i]: S.layouts[i] } : {};
  return o;
}
function openEncounter(i){ stopPlay(); S.enc = i; S.replay = null; setMode('setup'); renderAll(); scheduleSave(); }
window.WarTable = { show, simOpts: simOptsFor, openEncounter };

})();

if(location.hash) showView(location.hash.slice(1), true);
