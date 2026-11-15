// EMBERLINE v2 — palette. One dusk-industrial palette, used by every module
// so the map, the characters and the HUD read as one place: warm amber key
// light against cool blue-grey steel, with ember orange for the attacking
// team and ice teal for the defenders. v2 brightens the yard (lighter canvas
// and ground, stronger key light) and adds the upper-deck accent colours so
// the second floor reads at a glance. Every colour the game shows is one of
// these.
export const PALETTE = {
  canvas: '#232833', // dusk sky / fog
  ground: '#33363f', // concrete yard
  groundDark: '#282b32',
  steel: '#464c59', // walls and containers, cool
  steelDark: '#363b46',
  rust: '#8a5535', // rusted containers and beams
  amber: '#f0a830', // site markings, accents, Ember team
  ember: '#ff7a1a', // Ember team colour
  emberDark: '#b34d00',
  teal: '#35c8b8', // Vanta team colour
  tealDark: '#0f6f66',
  ink: '#f2eee2', // HUD text
  muted: '#a8aebb', // secondary HUD text
  danger: '#e5484d', // damage, enemy tracers
  good: '#7dc383', // health, win
  crate: '#7a6544', // wooden crates
  barrel: '#55663f', // olive barrels
  hazard: '#e0b32a', // hazard stripes
  deck: '#4d5462', // upper deck floor
  deckEdge: '#ffd25e', // deck edge glow
  white: '#ffffff',
};

export const TEAM = {
  ember: { name: 'EMBER', color: PALETTE.ember, dark: PALETTE.emberDark },
  vanta: { name: 'VANTA', color: PALETTE.teal, dark: PALETTE.tealDark },
};
