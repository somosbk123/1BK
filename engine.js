'use strict';
// Motor de reglas de 1BK (compartido por servidor y cliente)
//ENGINE-START
const COLORS = ['a','b','c','d'];
function buildDeck(){
  const d = [];
  for (const c of COLORS){
    d.push(c+'0');
    for (const v of ['1','2','3','4','5','6','7','8','9','s','r','p']) d.push(c+v, c+v);
  }
  for (let i=0;i<4;i++) d.push('w','x');
  return d;
}
function shuffle(a, rng){
  rng = rng || Math.random;
  for (let i=a.length-1;i>0;i--){ const j = Math.floor(rng()*(i+1)); const t=a[i]; a[i]=a[j]; a[j]=t; }
  return a;
}
function isWild(c){ return c==='w' || c==='x'; }
function topCard(g){ return g.discard[g.discard.length-1]; }
function pendKind(g){ return g.pend>0 ? (g.pendT || 'p') : ''; }   // '' | 'p' | 'x'
function canPlay(card, g){
  const k = pendKind(g);
  if (k==='p') return !isWild(card) && card[1]==='p';   // a un +2 se responde con otro +2
  if (k==='x') return card==='x';                       // a un +4 se responde con otro +4
  if (isWild(card)) return true;
  const top = topCard(g);
  return card[0]===g.color || (!isWild(top) && card[1]===top[1]);
}
function clone(g){ return JSON.parse(JSON.stringify(g)); }
function newGame(order, names, rng){
  const deck = shuffle(buildDeck(), rng);
  const hands = {};
  for (const p of order) hands[p] = deck.splice(0,7);
  let i = deck.findIndex(c => !isWild(c) && c[1]>='0' && c[1]<='9');
  const start = deck.splice(i,1)[0];
  return { order: order.slice(), names: names||{}, hands, deck, discard:[start], color:start[0],
           turn:0, dir:1, drew:false, pend:0, pendT:'', winner:null, seq:1,
           last:{t:'start', by:'', card:start, to:'', n:0, pen:false, chispa:false} };
}
function drawCards(g, pid, n, rng){
  let got = 0;
  for (let i=0;i<n;i++){
    if (!g.deck.length){
      if (g.discard.length<=1) break;
      const top = g.discard.pop();
      g.deck = shuffle(g.discard, rng); g.discard = [top];
    }
    g.hands[pid].push(g.deck.pop()); got++;
  }
  return got;
}
function advance(g, steps){
  const n = g.order.length;
  g.turn = (((g.turn + g.dir*steps) % n) + n) % n;
  g.drew = false;
}
function nextPid(g){ const n=g.order.length; return g.order[(((g.turn+g.dir)%n)+n)%n]; }
function playCard(g0, pid, idx, color, called, rng){
  if (!g0 || g0.winner || g0.order[g0.turn]!==pid) return null;
  const g = clone(g0), hand = g.hands[pid];
  const card = hand && hand[idx];
  if (!card || !canPlay(card, g)) return null;
  if (isWild(card) && !COLORS.includes(color)) return null;
  hand.splice(idx,1); g.discard.push(card);
  g.color = isWild(card) ? color : card[0];
  g.last = {t:'play', by:pid, card, to:'', n:0, pen:false, chispa:false};
  g.seq++;
  if (!hand.length){ g.pend = 0; g.pendT = ''; g.winner = pid; return g; }
  if (hand.length===1){
    if (called) g.last.chispa = true;
    else { drawCards(g, pid, 2, rng); g.last.pen = true; }
  }
  const v = isWild(card) ? card : card[1];
  if (v==='s'){ g.last.to = nextPid(g); advance(g,2); }
  else if (v==='r'){ g.dir = -g.dir; if (g.order.length===2){ g.last.to = nextPid(g); advance(g,2); } else advance(g,1); }
  else if (v==='p' || v==='x'){
    const add = v==='p' ? 2 : 4;
    g.pend = (g.pend||0) + add; g.pendT = v;
    g.last.to = nextPid(g); g.last.n = g.pend; advance(g,1);
  }
  else advance(g,1);
  return g;
}
function drawAction(g0, pid, rng){
  if (!g0 || g0.winner || g0.order[g0.turn]!==pid) return null;
  if (g0.pend>0){   // roba todo lo acumulado y conserva el turno
    const g = clone(g0);
    const n = drawCards(g, pid, g.pend, rng);
    g.pend = 0; g.pendT = ''; g.drew = false; g.seq++;
    g.last = {t:'take', by:pid, card:'', to:'', n, pen:false, chispa:false};
    return g;
  }
  if (g0.drew) return null;
  const g = clone(g0);
  const n = drawCards(g, pid, 1, rng);
  g.drew = true; g.seq++;
  g.last = {t:'draw', by:pid, card:'', to:'', n, pen:false, chispa:false};
  if (!g.hands[pid].some(c => canPlay(c, g))) advance(g,1);
  return g;
}
function passAction(g0, pid){
  if (!g0 || g0.winner || g0.order[g0.turn]!==pid || !g0.drew || g0.pend>0) return null;
  const g = clone(g0);
  g.seq++; g.last = {t:'pass', by:pid, card:'', to:'', n:0, pen:false, chispa:false};
  advance(g,1);
  return g;
}
function botMove(g, pid, rng){
  const hand = g.hands[pid];
  const idxs = hand.map((c,i)=>i).filter(i => canPlay(hand[i], g));
  if (!idxs.length) return (g.drew && !(g.pend>0)) ? passAction(g, pid) : drawAction(g, pid, rng);
  const threat = g.hands[nextPid(g)].length <= 2;
  const score = i => { const c = hand[i];
    if (c==='x') return threat ? 9 : 1;
    if (c==='w') return 2;
    if ('srp'.includes(c[1])) return threat ? 8 : 5;
    return 4 + Number(c[1])/10; };
  idxs.sort((a,b)=>score(b)-score(a));
  const i = idxs[0];
  const count = {a:0,b:0,c:0,d:0};
  hand.forEach((c,j)=>{ if (j!==i && !isWild(c)) count[c[0]]++; });
  const color = COLORS.slice().sort((x,y)=>count[y]-count[x])[0];
  return playCard(g, pid, i, color, true, rng);
}

module.exports = { COLORS, buildDeck, shuffle, isWild, topCard, pendKind, canPlay, newGame, drawAction, passAction, playCard, botMove, nextPid };
