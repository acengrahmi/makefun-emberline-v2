// Bots: nine AI fighters that fill both teams around the player. Each bot runs
// the same movement controller and the same weapons as the player, and decides
// what to do from a small state machine: follow a waypoint route to its site,
// hold an angle, fight what it can see, rotate to gunfire it hears, plant the
// charge or defuse it. Roles differ per bot: rushers push, holders sit on
// angles, the lurker works mid, rotators answer noise, the flanker climbs to
// the Upper Deck and the sniper holds it.
//
// v2 balance (v1 lost 7–0 to an idle player, all defender): the Ember team now
// pushes ONE site together — a team site call each round, announced in the
// banner — instead of five bots splitting across both sites; attackers react
// a touch faster and aim a touch truer on the push, defenders react slower
// while holding; and rushers throw a flash or frag into the site as they
// enter, so a site take is a team play, not five 1v1s.
import * as THREE from 'three';
import { createPlayer } from './player.js';
import { WEAPONS, createWeapon } from './weapons.js';
import { createSoldier, updateSoldier, layDownSoldier } from './characters.js';

const BOT_NAMES = {
  ember: ['ASH', 'COAL', 'SPARK', 'FLINT'],
  vanta: ['FROST', 'GLACIER', 'MIST', 'HAIL', 'SLEET'],
};

const ROLE_LOADOUT = {
  rusher: 'rifle',
  holder: 'rifle',
  lurker: 'smg',
  rotator: 'rifle',
  sniper: 'sniper',
  flanker: 'smg',
};

function pickSite(rng) {
  return rng() < 0.5 ? 'A' : 'B';
}

export function createBot(G, team, role, index, spawnPos) {
  const body = createPlayer(G.world.colliders, { x: spawnPos.x, y: 0, z: spawnPos.z, yaw: team === 'ember' ? 0 : Math.PI });
  const soldier = createSoldier(team);
  G.scene.add(soldier.group);
  const name = BOT_NAMES[team][index % BOT_NAMES[team].length];
  const bot = {
    isBot: true,
    name,
    team,
    role,
    body,
    soldier,
    weapon: createWeapon(ROLE_LOADOUT[role] ?? 'rifle'),
    weaponId: ROLE_LOADOUT[role] ?? 'rifle',
    hp: 100,
    armor: 50,
    alive: true,
    money: 800,
    kills: 0,
    deaths: 0,
    sitePref: pickSite(G.rng),
    state: 'move',
    path: [],
    pathIndex: 0,
    holdNode: null,
    holdYaw: 0,
    target: null,
    lastSeenPos: new THREE.Vector3(),
    lastSeenTime: -99,
    reactionEnd: 0,
    aimError: 0.05,
    burstLeft: 0,
    burstPause: 0,
    strafeDir: 1,
    strafeTimer: 0,
    blockedTimer: 0,
    stuckPos: new THREE.Vector3(spawnPos.x, 0, spawnPos.z),
    stuckCheckT: 0,
    detourDir: 1,
    detourActive: false,
    detourPos: new THREE.Vector3(),
    currentDest: null,
    walkPhase: 0,
    flashT: 0,
    plantProgress: 0,
    defuseProgress: 0,
    hasSpike: false,
    hearPos: null,
    hearTime: -99,
    thinkTimer: G.rng() * 0.3,
    deckPhase: false,
    staged: false,
    threwEntry: false,
  };
  // holder's perch: a node near its site, facing the likely approach; two in
  // five holders take the deck above their site instead
  if (role === 'holder') {
    if (G.rng() < 0.4) {
      bot.holdNode = bot.sitePref === 'A' ? 'deckW' : 'deckE';
      bot.holdYaw = Math.PI;
    } else {
      bot.holdNode = bot.sitePref === 'A' ? 'aHold' : 'bHold';
      bot.holdYaw = bot.sitePref === 'A' ? Math.PI * 0.75 : Math.PI * 0.25;
    }
  }
  if (role === 'sniper') {
    // the sniper holds the middle of the Upper Deck, over the whole yard
    bot.holdNode = 'deckMid';
    bot.holdYaw = Math.PI;
  }
  return bot;
}

/** Choose a destination node id for a bot that has no objective right now. */
function objectiveNode(G, bot) {
  const world = G.world;
  const spike = G.spike;
  if (bot.team === 'ember') {
    if (spike.state === 'planted') return spike.site === 'A' ? 'aSite' : 'bSite';
    if (bot.hasSpike) return G.teamSite === 'A' ? 'aSite' : 'bSite';
    if (spike.state === 'dropped') return world.nearestNode(spike.pos);
    // the flanker climbs to the deck above the called site, then drops onto it
    if (bot.role === 'flanker' && !bot.deckPhase) {
      return G.teamSite === 'A' ? 'deckW' : 'deckE';
    }
    // the lurker stages at the alley first and trails the push in, instead of
    // walking solo into mid and dying alone
    if (bot.role === 'lurker' && !bot.staged) {
      return G.teamSite === 'A' ? 'aAlley' : 'bAlley';
    }
    // everyone else pushes the called site, together
    return G.teamSite === 'A' ? 'aSite' : 'bSite';
  }
  // vanta (defenders)
  if (spike.state === 'planted') return spike.site === 'A' ? 'aSite' : 'bSite';
  if (bot.role === 'holder' || bot.role === 'sniper') return bot.holdNode;
  if (bot.hearTime > G.time - 6 && bot.hearPos) {
    // rotate toward nearby noise only: a rotator that chases gunfire across
    // the map abandons its site for nothing
    const bp = bot.body.state.position;
    if (Math.hypot(bot.hearPos.x - bp.x, bot.hearPos.z - bp.z) < 22) {
      return world.nearestNode(bot.hearPos);
    }
  }
  return bot.sitePref === 'A' ? 'defA' : 'defB';
}

function setPath(G, bot, destNode) {
  const from = startNodeFor(G, bot);
  bot.path = G.world.findPath(from, destNode);
  bot.pathIndex = 0;
  // the bot is already standing on the start node: skip it, or it will
  // orbit the node forever — the direction to a node under your feet swings
  // faster than the bot can turn, so it chases its own tail in a circle
  const pos = bot.body.state.position;
  while (bot.path.length > 1) {
    const node = G.world.byId.get(bot.path[0]);
    if (Math.hypot(node.pos.x - pos.x, node.pos.z - pos.z) < 1.0) bot.path.shift();
    else break;
  }
}

/** The node a bot starts its route from. The graph is 2D but the map is
 * not: a bot standing on the ground under the Upper Deck is 2D-close to a
 * deck node it cannot reach, and a bot on the deck is 2D-close to a ground
 * node below it. Both make the bot walk into a solid face — the deck's edge
 * or a staircase's north side — and freeze. So the start node is chosen
 * height-aware: a ground bot starts from a stair approach, a deck bot from
 * a deck node. */
const DECK_TO_STAIRS = { deckW: 'stairAS', deckE: 'stairBS', deckMid: 'stairMS' };
const STAIR_TO_APPROACH = { stairA: 'stairAS', stairB: 'stairBS', stairM: 'stairMS' };
const UNDER_DECK_NODES = new Set(['aBack', 'bBack', 'defA', 'defB', 'defSpawn']);
function startNodeFor(G, bot) {
  const pos = bot.body.state.position;
  const id = G.world.nearestNode(pos);
  if (pos.y < 1.5) {
    if (DECK_TO_STAIRS[id]) return DECK_TO_STAIRS[id];
    // a stair node approached from the north (under the deck) is the wrong
    // side: the stairs are climbed from the south, via the approach node
    if (STAIR_TO_APPROACH[id] && pos.z < G.world.byId.get(id).pos.z) return STAIR_TO_APPROACH[id];
    return id;
  }
  if (UNDER_DECK_NODES.has(id)) {
    return pos.x < -7 ? 'deckW' : pos.x > 7 ? 'deckE' : 'deckMid';
  }
  return id;
}

const _eye = new THREE.Vector3();
const _targetEye = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

/** The nearest enemy this bot can actually see right now, or null. The
 * sniper keeps a long sightline; everyone else only really sees 24 m, so a
 * push is not stopped by a dot on the horizon. */
function visibleEnemy(G, bot) {
  const pos = bot.body.state.position;
  _eye.set(pos.x, pos.y + bot.body.state.eye, pos.z);
  const range = bot.role === 'sniper' ? 34 : 24;
  let best = null;
  let bestD = range;
  for (const f of G.fighters) {
    if (!f.alive || f.team === bot.team) continue;
    const fp = f.body.state.position;
    const dx = fp.x - pos.x;
    const dz = fp.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > bestD) continue;
    // must be roughly in front, unless it was just seen (peripheral memory)
    const angTo = Math.atan2(-dx, -dz);
    let diff = angTo - bot.body.state.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const seenRecently = f === bot.target && G.time - bot.lastSeenTime < 1.2;
    if (Math.abs(diff) > 1.15 && !seenRecently) continue;
    _targetEye.set(fp.x, fp.y + f.body.state.eye * 0.85, fp.z);
    if (!G.world.lineOfSight(_eye, _targetEye, range + 2)) continue;
    best = f;
    bestD = dist;
  }
  return best;
}

function turnToward(bot, targetYaw, dt, rate = 4.2) {
  let diff = targetYaw - bot.body.state.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = Math.max(-rate * dt, Math.min(rate * dt, diff));
  bot.body.state.yaw += step;
  return diff;
}

function moveAlongPath(G, bot, dt, keys) {
  const pos = bot.body.state.position;
  if (bot.pathIndex >= bot.path.length) return false;
  const node = G.world.byId.get(bot.path[bot.pathIndex]);
  const dx = node.pos.x - pos.x;
  const dz = node.pos.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.9) {
    bot.pathIndex += 1;
    return bot.pathIndex < bot.path.length;
  }
  let targetYaw = Math.atan2(-dx, -dz);
  // wall-slide: a bot that is pushing but barely moving is against a wall
  // or a crate corner. Stuck is judged by PROGRESS, not speed — a bot
  // grinding along a wall still shows 1-2 m/s on the free axis while its
  // net displacement is ~0, so a speed test never fires. Once stuck, LATCH
  // the detour: steer ~86 degrees to one side (nearly perpendicular, so it
  // slides along the face instead of back into it) and keep sliding until
  // it has cleared the obstacle (1.5 m from where it got stuck). Without
  // the latch the detour switches off the moment the bot starts moving, so
  // it turns back into the wall and oscillates in place forever.
  if (G.time - bot.stuckCheckT > 1) {
    const moved = pos.distanceTo(bot.stuckPos);
    if (moved < 0.5) {
      bot.blockedTimer += G.time - bot.stuckCheckT;
      if (!bot.detourActive) {
        bot.detourActive = true;
        bot.detourPos.copy(pos);
      }
      if (bot.blockedTimer > 3) {
        bot.blockedTimer = 0;
        bot.detourDir *= -1;
        bot.detourActive = false;
        const dest = bot.path[bot.path.length - 1];
        setPath(G, bot, dest);
      }
    } else {
      bot.blockedTimer = 0;
    }
    bot.stuckPos.copy(pos);
    bot.stuckCheckT = G.time;
  }
  if (bot.detourActive) {
    targetYaw += 1.5 * bot.detourDir;
    if (pos.distanceTo(bot.detourPos) > 1.5) bot.detourActive = false;
  }
  // close to the node, face it exactly: the direction to a node under your
  // feet swings faster than the turn rate can follow, so a bot that turns
  // toward it while walking orbits the node in a circle instead of arriving.
  // A detouring bot snaps too — turning gradually toward the slide direction
  // while grinding into the wall bleeds the slide to ~1 m/s; snapping makes
  // it slide along the face at full speed.
  if (dist < 2.0 || bot.detourActive) bot.body.state.yaw = targetYaw;
  else turnToward(bot, targetYaw, dt, 5);
  keys.add('KeyW');
  return true;
}

/** Aim the soldier's mesh at its body's position and pose, from the sim. */
export function syncBotVisual(G, bot, dt) {
  const body = bot.body.state;
  const speed = bot.body.groundSpeed();
  bot.walkPhase += dt * speed * 1.9;
  bot.soldier.group.position.set(body.position.x, body.position.y, body.position.z);
  updateSoldier(bot.soldier, {
    speed,
    yaw: body.yaw,
    pitch: body.pitch,
    crouching: body.crouching,
    firing: false,
    walkPhase: bot.walkPhase,
    baseY: body.position.y,
  });
  bot.soldier.group.updateMatrixWorld(true);
}

/** Where, in words, a bot is — for its comms callouts. */
function zoneName(G, bot) {
  const p = bot.body.state.position;
  if (p.y > 1.5) return 'UPPER DECK';
  if (p.x < -14) return p.z < -8 ? 'SITE A' : 'A LONG';
  if (p.x > 14) return p.z < -8 ? 'SITE B' : 'B LONG';
  if (Math.abs(p.x) < 6 && p.z < -4) return 'MID';
  return p.z > 8 ? 'SPAWN' : 'YARD';
}

export function updateBot(G, bot, dt) {
  if (!bot.alive) return;
  const body = bot.body.state;
  const keys = new Set();
  bot.thinkTimer -= dt;
  bot.weapon.step(G.time, dt);
  if (bot.weapon.mag <= 0 && !bot.weapon.reloading) bot.weapon.startReload(G.time);

  // flashed: blind, cannot fire, stands still
  if (bot.flashT > 0) {
    bot.flashT -= dt;
    bot.body.step(dt, keys);
    syncBotVisual(G, bot, dt);
    return;
  }

  // ---- perception
  let enemy = visibleEnemy(G, bot);
  // push discipline: an attacker with no target yet ignores a distant dot and
  // keeps pushing to the site; the fight starts at 20 m, not across the map
  if (enemy && bot.team === 'ember' && !bot.target) {
    const ep = enemy.body.state.position;
    const d = Math.hypot(ep.x - body.position.x, ep.z - body.position.z);
    if (d > 20) enemy = null;
  }
  if (enemy) {
    if (bot.target !== enemy) {
      bot.target = enemy;
      // attackers on the push react faster; holders react slower. The push
      // is 4 bots against 5 defenders while the player sits out, and the
      // movement fixes let the defence set up properly now — so the
      // attackers need the sharper edge to keep rounds alive.
      const reaction = bot.team === 'ember'
        ? 0.22 + G.rng() * 0.33
        : 0.52 + G.rng() * 0.5;
      bot.reactionEnd = G.time + reaction;
      bot.aimError = (bot.team === 'ember' ? 0.035 : 0.055) + G.rng() * 0.02;
      bot.burstLeft = 0;
      // a fresh spot is worth a callout, throttled so the feed stays readable
      if (G.rng() < 0.5 && G.time - (G.lastComms ?? -99) > 4) {
        G.lastComms = G.time;
        G.hud.comms(`${bot.name}: CONTACT ${zoneName(G, bot)}`);
      }
    }
    bot.lastSeenPos.copy(enemy.body.state.position);
    bot.lastSeenTime = G.time;
    // a fast-moving target is hard to track: the aim error never settles
    // below 0.03 while the target runs, so a push that keeps moving survives
    const targetSpeed = enemy.body.groundSpeed();
    const floor = targetSpeed > 3 ? 0.03 : 0.008;
    bot.aimError = Math.max(floor, bot.aimError - dt * 0.03);
  } else if (bot.target && G.time - bot.lastSeenTime > 1.2) {
    bot.target = null;
  }

  // ---- combat
  if (bot.target && bot.target.alive) {
    bot.state = 'combat';
    const tp = bot.target.body.state.position;
    _toTarget.set(tp.x - body.position.x, 0, tp.z - body.position.z);
    const dist = _toTarget.length();
    const targetYaw = Math.atan2(-_toTarget.x, -_toTarget.z);
    turnToward(bot, targetYaw, dt, 6);
    // aim the pitch at the chest/head
    const dy = tp.y + bot.target.body.state.eye * 0.9 - (body.position.y + body.eye);
    const targetPitch = Math.atan2(dy, Math.max(1, dist));
    body.pitch += (targetPitch - body.pitch) * Math.min(1, dt * 8);
    // strafe and keep a fighting distance
    bot.strafeTimer -= dt;
    if (bot.strafeTimer <= 0) {
      bot.strafeTimer = 0.6 + G.rng() * 0.7;
      bot.strafeDir = G.rng() < 0.5 ? -1 : 1;
    }
    if (dist > 20) keys.add('KeyW');
    else if (dist < 6) keys.add('KeyS');
    keys.add(bot.strafeDir > 0 ? 'KeyD' : 'KeyA');
    if (bot.hp < 35 && G.rng() < 0.3) keys.add('ControlLeft');
    // fire in bursts once the reaction time has passed
    if (G.time >= bot.reactionEnd && bot.weapon.ready(G.time)) {
      if (bot.burstLeft <= 0) {
        if (bot.burstPause <= 0) {
          bot.burstLeft = 3 + Math.floor(G.rng() * 3);
          bot.burstPause = 0.5 + G.rng() * 0.5;
        } else {
          bot.burstPause -= dt;
        }
      }
      if (bot.burstLeft > 0) {
        G.combat.fire(G, bot, bot.aimError);
        bot.burstLeft -= 1;
      }
    }
    bot.body.step(dt, keys);
    syncBotVisual(G, bot, dt);
    return;
  }

  // ---- objective behaviour
  bot.state = 'move';
  const spike = G.spike;
  if (bot.team === 'ember' && bot.hasSpike && spike.state === 'carried') {
    const site = G.world.sites[G.teamSite];
    const d = Math.hypot(site.center.x - body.position.x, site.center.z - body.position.z);
    if (d < site.radius - 0.5) {
      bot.state = 'plant';
      bot.plantProgress += dt;
      if (bot.plantProgress >= 3.5) {
        bot.plantProgress = 0;
        G.match.plantSpike(G, bot, G.teamSite);
      }
      bot.body.step(dt, keys);
      syncBotVisual(G, bot, dt);
      return;
    }
  }
  if (bot.team === 'vanta' && spike.state === 'planted') {
    const d = Math.hypot(spike.pos.x - body.position.x, spike.pos.z - body.position.z);
    if (d < 2.6) {
      bot.state = 'defuse';
      bot.defuseProgress += dt;
      if (Math.floor(bot.defuseProgress * 2) !== Math.floor((bot.defuseProgress - dt) * 2)) G.audio.defuseBeep();
      if (bot.defuseProgress >= 5) {
        bot.defuseProgress = 0;
        G.match.defuseSpike(G, bot);
      }
      bot.body.step(dt, keys);
      syncBotVisual(G, bot, dt);
      return;
    }
  }
  // holders sit on their angle once they arrive — a deck hold only counts
  // when the bot is actually up on the deck, not on the ground below it
  if ((bot.role === 'holder' || bot.role === 'sniper') && bot.holdNode && spike.state !== 'planted') {
    const node = G.world.byId.get(bot.holdNode);
    const d = Math.hypot(node.pos.x - body.position.x, node.pos.z - body.position.z);
    const deckHold = bot.holdNode === 'deckW' || bot.holdNode === 'deckMid' || bot.holdNode === 'deckE';
    if (d < 1.2 && (!deckHold || body.position.y > 1.5)) {
      bot.state = 'hold';
      turnToward(bot, bot.holdYaw + Math.sin(G.time * 0.4 + bot.walkPhase) * 0.25, dt, 2);
      if (bot.role === 'sniper' && G.rng() < 0.002) keys.add('ControlLeft');
      bot.body.step(dt, keys);
      syncBotVisual(G, bot, dt);
      return;
    }
  }
  // the flanker, once on the deck, drops onto the called site
  if (bot.role === 'flanker' && !bot.deckPhase && !bot.hasSpike) {
    const deckNode = G.world.byId.get(G.teamSite === 'A' ? 'deckW' : 'deckE');
    const d = Math.hypot(deckNode.pos.x - body.position.x, deckNode.pos.z - body.position.z);
    if (d < 1.5 && body.position.y > 1.5) {
      bot.deckPhase = true;
      bot.path = [];
      bot.pathIndex = 0;
      bot.currentDest = null;
    }
  }
  // the lurker, once at its staging alley, joins the push
  if (bot.role === 'lurker' && !bot.staged) {
    const stageNode = G.world.byId.get(G.teamSite === 'A' ? 'aAlley' : 'bAlley');
    const d = Math.hypot(stageNode.pos.x - body.position.x, stageNode.pos.z - body.position.z);
    if (d < 1.5) {
      bot.staged = true;
      bot.path = [];
      bot.pathIndex = 0;
      bot.currentDest = null;
    }
  }
  // entry utility: a rusher or flanker throws a flash into the site as the
  // push arrives, so holders cannot just hold the angle for free
  if (!bot.threwEntry && bot.team === 'ember' && (bot.role === 'rusher' || bot.role === 'flanker')) {
    const site = G.world.sites[G.teamSite];
    const d = Math.hypot(site.center.x - body.position.x, site.center.z - body.position.z);
    if (d < 14 && bot.grenades) {
      if ((bot.grenades.flash ?? 0) > 0) {
        bot.threwEntry = true;
        // face the site, then throw over the approach
        const targetYaw = Math.atan2(-(site.center.x - body.position.x), -(site.center.z - body.position.z));
        body.yaw = targetYaw;
        G.match.throwGrenade(G, bot, 'flash');
      } else if ((bot.grenades.frag ?? 0) > 0 && d < 11) {
        bot.threwEntry = true;
        const targetYaw = Math.atan2(-(site.center.x - body.position.x), -(site.center.z - body.position.z));
        body.yaw = targetYaw;
        G.match.throwGrenade(G, bot, 'frag');
      }
    }
  }

  // Re-path only when the objective changes, or when the path is genuinely
  // exhausted while the bot is still far from its destination. The old code
  // re-pathed every frame once a bot stood on its destination node, which
  // reset thinkTimer each frame and froze the bot in place forever.
  const dest = objectiveNode(G, bot);
  const destNode = G.world.byId.get(dest);
  const destDist = Math.hypot(destNode.pos.x - body.position.x, destNode.pos.z - body.position.z);
  // a deck destination only counts as reached when the bot is actually up
  // there — a ground bot 2D-close to a deck node is standing under it
  const deckDest = dest === 'deckW' || dest === 'deckMid' || dest === 'deckE';
  const arrived = destDist < 1.2 && (!deckDest || body.position.y > 1.5);
  if (dest !== bot.currentDest) {
    bot.currentDest = dest;
    bot.detourActive = false;
    setPath(G, bot, dest);
  } else if (bot.pathIndex >= bot.path.length && !arrived) {
    // path exhausted but not there yet (knocked off course in a fight):
    // recompute from where the bot actually stands
    setPath(G, bot, dest);
  }
  // arrived: hold the angle and scan instead of re-pathing forever —
  // attackers face the site (north), defenders face the push (south)
  let moved = false;
  if (!arrived) {
    moved = moveAlongPath(G, bot, dt, keys);
  } else {
    const faceYaw = bot.team === 'ember' ? 0 : Math.PI;
    turnToward(bot, faceYaw + Math.sin(G.time * 0.4 + bot.walkPhase) * 0.3, dt, 2);
  }
  // a dropped charge is recovered by walking straight at it, not at the
  // waypoint nearest to it — the waypoint can sit metres from the charge
  if (!moved && spike.state === 'dropped' && bot.team === 'ember') {
    const dx = spike.pos.x - body.position.x;
    const dz = spike.pos.z - body.position.z;
    if (Math.hypot(dx, dz) > 0.5) {
      turnToward(bot, Math.atan2(-dx, -dz), dt, 5);
      keys.add('KeyW');
    }
  }
  bot.body.step(dt, keys);
  bot._lastSpeed = bot.body.groundSpeed();
  bot._lastKeys = [...keys].join('+');
  syncBotVisual(G, bot, dt);
}

/** Kill a bot: fall over, drop the spike if carried, remove from the fight.
 * (damageFighter already counted the death; this only changes the pose.) */
export function killBot(G, bot) {
  bot.alive = false;
  layDownSoldier(bot.soldier, bot.body.state.position.y);
  if (bot.hasSpike) {
    bot.hasSpike = false;
    G.spike.state = 'dropped';
    G.spike.pos.copy(bot.body.state.position);
    G.spike.carrier = null;
  }
}
