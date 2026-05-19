// Generic, club-inspired colour palette indexed by FPL team short name.
// These are intentionally NOT official kits / logos / sponsors. They're abstract
// blocks the designer can re-skin later. Any team without an entry falls back
// to the neutral steel block.
export const TEAM_COLOURS: Record<string, { primary: string; secondary: string }> = {
  ARS: { primary: '#E04A4A', secondary: '#FFFFFF' },
  AVL: { primary: '#7A1B45', secondary: '#9DD9EA' },
  BOU: { primary: '#D62A2A', secondary: '#1F1F1F' },
  BRE: { primary: '#D9402B', secondary: '#FFFFFF' },
  BHA: { primary: '#1E73BE', secondary: '#FFFFFF' },
  BUR: { primary: '#5A1D45', secondary: '#A3C7E0' },
  CHE: { primary: '#1E3A8A', secondary: '#FFFFFF' },
  CRY: { primary: '#1E3A8A', secondary: '#D62A2A' },
  EVE: { primary: '#274F86', secondary: '#FFFFFF' },
  FUL: { primary: '#EEEEEE', secondary: '#1F1F1F' },
  IPS: { primary: '#1E3A8A', secondary: '#FFFFFF' },
  LEI: { primary: '#234E8A', secondary: '#FFC72C' },
  LIV: { primary: '#A8202C', secondary: '#FFFFFF' },
  MCI: { primary: '#5BA7D3', secondary: '#FFFFFF' },
  MUN: { primary: '#D62A2A', secondary: '#FFC72C' },
  NEW: { primary: '#0F1216', secondary: '#FFFFFF' },
  NOT: { primary: '#C2241F', secondary: '#FFFFFF' },
  SOU: { primary: '#C8102E', secondary: '#FFFFFF' },
  TOT: { primary: '#1E3A8A', secondary: '#FFFFFF' },
  WHU: { primary: '#5A1D45', secondary: '#9DD9EA' },
  WOL: { primary: '#F4A41A', secondary: '#1F1F1F' }
};

export function teamColour(shortName: string) {
  return TEAM_COLOURS[shortName] ?? { primary: '#2A3140', secondary: '#E6EAF2' };
}
