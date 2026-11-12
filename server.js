'use strict';
// Servidor de 1BK: HTTP + SSE, sin dependencias. El servidor es la autoridad del juego:
// las manos de los demás nunca se envían a los clientes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 6, MAX_ROOMS = 500, ROOM_TTL = 6 * 3600e3;
const BOT_NAMES = ['Bot Lía', 'Bot Teo', 'Bot Nube', 'Bot Rayo', 'Bot Kiwi'];
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const rooms = new Map();

const clean = (s, n, fb) => { s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n); return s || fb || ''; };
const rid = n => { let s = ''; const b = crypto.randomBytes(n); for (let i = 0; i < n; i++) s += ALPHA[b[i] % ALPHA.length]; return s; };
const pidOf = key => crypto.createHash('sha256').update('1bk:' + key).digest('hex').slice(0, 16);
const validKey = k => typeof k === 'string' && /^[A-Za-z0-9_\-.~:@+]{8,200}$/.test(k);
const isBot = p => typeof p === 'string' && p.startsWith('bot-');

function mask(g, pid) {
  if (!g) return '';
  const hands = {};
  for (const p of g.order) hands[p] = p === pid ? g.hands[p] : new Array(g.hands[p].length).fill('?');
  return Object.assign({}, g, { hands, deck: new Array(g.deck.length).fill('?') });
}
function viewFor(r, pid) {
  const players = {};
  for (const [id, p] of r.players) players[id] = { name: p.name, at: p.at };
  return { you: pid, room: { name: r.name, hostId: r.hostId, status: r.status, bots: r.bots }, players, g: mask(r.g, pid) };
}
function send(res, data) { try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* conexión cerrada */ } }
function broadcast(r) {
  r.touched = Date.now();
  for (const [id, p] of r.players) for (const res of p.conns) send(res, viewFor(r, id));
  for (const [res, pid] of r.watchers) send(res, viewFor(r, r.players.has(pid) ? pid : ''));
  schedule(r);
}

// ---- turnos automáticos: bots y jugadores desconectados ----
function schedule(r) {
  clearTimeout(r.timer);
  const g = r.g;
  if (r.status !== 'playing' || !g || g.winner) return;
  const cur = g.order[g.turn], seq = g.seq;
  if (isBot(cur)) {
    const special = g.last && g.last.card && /^(x|w|.[srp])$/.test(g.last.card);
    r.timer = setTimeout(() => {
      if (r.g !== g || g.seq !== seq) return;
      const n = E.botMove(g, cur);
      if (n) { r.g = n; if (n.winner) r.status = 'ended'; broadcast(r); }
    }, 1500 + Math.random() * 900 + (special ? 1300 : 0));
  } else {
    r.timer = setTimeout(() => {
      if (r.g !== g || g.seq !== seq) return;
      const p = r.players.get(cur);
      if (!p || p.conns.size === 0) { const n = skipTurn(g, cur); if (n !== g) { r.g = n; if (n.winner) r.status = 'ended'; broadcast(r); } }
    }, 25000);
  }
}
function skipTurn(g, cur) {
  let n = g;
  if (n.pend > 0) n = E.drawAction(n, cur) || n;
  if (n.order[n.turn] === cur && !n.drew) n = E.drawAction(n, cur) || n;
  if (n.order[n.turn] === cur && !n.winner) n = E.passAction(n, cur) || n;
  return n;
}

function newRoom(hostPid, hostName) {
  let code; do { code = rid(5); } while (rooms.has(code));
  const r = { code, name: 'Sala de ' + hostName, hostId: hostPid, status: 'lobby', bots: [], players: new Map(), watchers: new Map(), g: null, timer: 0, touched: Date.now(), turnAt: 0 };
  r.players.set(hostPid, { name: hostName, at: Date.now(), conns: new Set(), seen: Date.now() });
  rooms.set(code, r);
  return r;
}
function removePlayer(r, pid) {
  const p = r.players.get(pid); if (!p) return;
  for (const res of p.conns) { try { res.end(); } catch (e) { } }
  r.players.delete(pid);
  if (r.hostId === pid) {
    const next = [...r.players.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (next) r.hostId = next[0]; else { clearTimeout(r.timer); rooms.delete(r.code); return; }
  }
}

function act(r, pid, b) {
  const g = r.g, host = r.hostId === pid, me = r.players.get(pid);
  const fail = (code, error) => ({ code, error });
  switch (b.type) {
    case 'join': {
      if (me) { me.name = clean(b.name, 16, me.name); break; }
      if (r.status !== 'lobby') return fail(409, 'La partida ya empezó.');
      if (r.players.size + r.bots.length >= MAX_PLAYERS) return fail(409, 'La sala está llena.');
      r.players.set(pid, { name: clean(b.name, 16, 'Jugador'), at: Date.now(), conns: new Set(), seen: Date.now() });
      break;
    }
    case 'rename': if (!me) return fail(403, 'No estás en la sala.'); me.name = clean(b.name, 16, me.name); break;
    case 'leave': if (!me) break; if (r.status === 'lobby') { removePlayer(r, pid); if (!rooms.has(r.code)) return { ok: true }; } break;
    case 'kick': if (!host || b.id === pid || r.status !== 'lobby') return fail(403, 'No permitido.'); removePlayer(r, String(b.id)); break;
    case 'roomname': if (!host) return fail(403, 'Solo el anfitrión.'); r.name = clean(b.name, 24, r.name); break;
    case 'addbot': {
      if (!host || r.status !== 'lobby') return fail(403, 'No permitido.');
      if (r.players.size + r.bots.length >= MAX_PLAYERS) return fail(409, 'La sala está llena.');
      const used = r.bots.map(x => x.name);
      r.bots.push({ id: 'bot-' + rid(4), name: BOT_NAMES.find(n => !used.includes(n)) || 'Bot' });
      break;
    }
    case 'delbot': if (!host || r.status !== 'lobby') return fail(403, 'No permitido.'); r.bots = r.bots.filter(x => x.id !== b.id); break;
    case 'start': {
      if (!host || r.status === 'playing') return fail(403, 'No permitido.');
      const humans = [...r.players.entries()].sort((a, b2) => a[1].at - b2[1].at).map(e => e[0]);
      const order = humans.concat(r.bots.map(x => x.id)).slice(0, MAX_PLAYERS);
      if (order.length < 2) return fail(409, 'Se necesitan al menos 2 jugadores.');
      const names = {}; humans.forEach(id => names[id] = r.players.get(id).name); r.bots.forEach(x => names[x.id] = x.name);
      r.g = E.newGame(order, names); r.g.seq = Date.now(); r.status = 'playing';
      break;
    }
    case 'tolobby': if (!host) return fail(403, 'No permitido.'); clearTimeout(r.timer); r.g = null; r.status = 'lobby'; break;
    case 'draw': case 'pass': case 'play': {
      if (!g || r.status !== 'playing' || g.winner || g.order[g.turn] !== pid) return fail(409, 'No es tu turno.');
      let n = null;
      if (b.type === 'draw') n = E.drawAction(g, pid);
      else if (b.type === 'pass') n = E.passAction(g, pid);
      else {
        const i = Number(b.i);
        if (!Number.isInteger(i) || i < 0 || i >= g.hands[pid].length) return fail(400, 'Jugada inválida.');
        const color = E.COLORS.includes(b.color) ? b.color : null;
        n = E.playCard(g, pid, i, color, !!b.armed);
      }
      if (!n) return fail(409, 'Jugada no permitida.');
      r.g = n; if (n.winner) r.status = 'ended';
      break;
    }
    case 'hostskip': {
      if (!host || !g || g.winner || r.status !== 'playing') return fail(403, 'No permitido.');
      const cur = g.order[g.turn]; if (isBot(cur) || cur === pid) return fail(409, 'No permitido.');
      const n = skipTurn(g, cur); if (n !== g) { r.g = n; if (n.winner) r.status = 'ended'; }
      break;
    }
    default: return fail(400, 'Acción desconocida.');
  }
  return { ok: true };
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise(resolve => {
    let s = ''; req.on('data', d => { s += d; if (s.length > 4096) { req.destroy(); resolve(null); } });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), pn = url.pathname;
  try {
    if (pn === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'POST' && pn === '/api/rooms') {
      const b = await body(req); if (!b || !validKey(b.key)) return json(res, 400, { error: 'Solicitud inválida.' });
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Servidor lleno, inténtalo más tarde.' });
      const pid = pidOf(b.key), r = newRoom(pid, clean(b.name, 16, 'Jugador'));
      return json(res, 200, { code: r.code });
    }
    let m = /^\/api\/rooms\/([a-z0-9]{4,12})\/events$/.exec(pn);
    if (req.method === 'GET' && m) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      const r = rooms.get(m[1]), key = url.searchParams.get('k');
      if (!r) { res.write('event: gone\ndata: {}\n\n'); return res.end(); }
      const pid = validKey(key) ? pidOf(key) : '', p = r.players.get(pid);
      if (p) { p.conns.add(res); p.seen = Date.now(); } else r.watchers.set(res, pid);
      send(res, viewFor(r, p ? pid : ''));
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) { } }, 20000);
      req.on('close', () => { clearInterval(ka); r.watchers.delete(res); if (p) p.conns.delete(res); const q = r.players.get(pid); if (q) q.seen = Date.now(); });
      return;
    }
    m = /^\/api\/rooms\/([a-z0-9]{4,12})\/act$/.exec(pn);
    if (req.method === 'POST' && m) {
      const b = await body(req), r = rooms.get(m[1]);
      if (!b || !validKey(b.key)) return json(res, 400, { error: 'Solicitud inválida.' });
      if (!r) return json(res, 404, { error: 'La sala no existe.' });
      const out = act(r, pidOf(b.key), b);
      if (out.error) return json(res, out.code, { error: out.error });
      if (rooms.has(r.code)) broadcast(r);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pn);
    res.writeHead(405); res.end();
  } catch (e) { try { json(res, 500, { error: 'Error del servidor.' }); } catch (_) { } }
});
server.keepAliveTimeout = 65000;

// limpieza: salas viejas, anfitrión ausente, jugadores ausentes del lobby
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const online = [...r.players.values()].some(p => p.conns.size) || r.watchers.size;
    if (!online && now - r.touched > ROOM_TTL) { clearTimeout(r.timer); rooms.delete(code); continue; }
    if (r.status === 'lobby') for (const [id, p] of [...r.players]) if (!p.conns.size && now - p.seen > 10 * 60e3) removePlayer(r, id);
    if (!rooms.has(code)) continue;
    const host = r.players.get(r.hostId);
    if (host && !host.conns.size && now - host.seen > 2 * 60e3) {
      const next = [...r.players.entries()].filter(e => e[1].conns.size).sort((a, b) => a[1].at - b[1].at)[0];
      if (next) { r.hostId = next[0]; broadcast(r); }
    }
  }
}, 30000).unref();

if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log('1BK escuchando en el puerto ' + PORT));
module.exports = { server, rooms };
