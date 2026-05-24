'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

/**
 * Sidebar nav — grouped, with a collapsible "Lab" section for diagnostic
 * pages we don't want crowding the primary nav. The primary actions
 * (the GW decision flow: pitch / transfers / captain / chip / league /
 * creators / predicted lineups) stay always-visible. Everything else
 * (model audit, backtesting, single-purpose tools) sits under Lab and
 * defaults collapsed.
 */

interface NavItem {
  href: string;
  label: string;
}

interface NavSection {
  label: string | null;          // null = no header (used for the top primary action)
  items: NavItem[];
  collapsible?: boolean;
  defaultOpen?: boolean;
}

const SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { href: '/gw', label: '★ This Gameweek' }
    ]
  },
  {
    label: 'Decisions',
    items: [
      { href: '/my-team',          label: 'My Team' },
      { href: '/transfer-planner', label: 'Transfers' },
      { href: '/captaincy',        label: 'Captaincy' },
      { href: '/chip-planner',     label: 'Chips' }
    ]
  },
  {
    label: 'Intel',
    items: [
      { href: '/mini-league',        label: 'Mini Leagues' },
      { href: '/creator-signals',    label: 'Creators' },
      { href: '/press-conferences',  label: 'Press Conferences' },
      { href: '/predicted-lineups',  label: 'Predicted Lineups' },
      { href: '/player-explorer',    label: 'Player Explorer' }
    ]
  },
  {
    label: 'Lab',
    collapsible: true,
    defaultOpen: false,
    items: [
      { href: '/pitch',              label: 'Pitch View' },
      { href: '/decision-matrix',    label: 'Decision Matrix' },
      { href: '/creator-lineups',    label: 'Creator Lineups' },
      { href: '/creator-accuracy',   label: 'Creator Accuracy' },
      { href: '/minutes-lab',        label: 'Minutes Lab' },
      { href: '/role-matrix',        label: 'Role Matrix' },
      { href: '/rotation-radar',     label: 'Rotation Radar' },
      { href: '/fixture-congestion', label: 'Fixture Congestion' },
      { href: '/gw-checklist',       label: 'GW Checklist' },
      { href: '/model-audit',        label: 'Model Audit' },
      { href: '/model-lab',          label: 'Model Lab' },
      { href: '/backtesting',        label: 'Backtesting' },
      { href: '/',                   label: 'Dashboard (full)' }
    ]
  },
  {
    label: 'System',
    collapsible: true,
    defaultOpen: false,
    items: [
      { href: '/settings',         label: 'Settings' },
      { href: '/manual-overrides', label: 'Manual Overrides' }
    ]
  }
];

export function Nav() {
  return (
    <nav className="py-2">
      {SECTIONS.map((section, i) => (
        <NavGroup key={i} section={section} />
      ))}
    </nav>
  );
}

function NavGroup({ section }: { section: NavSection }) {
  const pathname = usePathname();
  // If any item in a collapsible section is active, force-open the group.
  const containsActive = section.items.some(it =>
    it.href === pathname || (it.href !== '/' && pathname?.startsWith(it.href))
  );
  const [open, setOpen] = useState(section.defaultOpen ?? !section.collapsible);
  const isOpen = section.collapsible ? (open || containsActive) : true;

  return (
    <div className="mb-2">
      {section.label && (
        section.collapsible ? (
          <button
            onClick={() => setOpen(o => !o)}
            className="w-full flex items-center justify-between px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-ink-dim hover:text-ink-muted"
          >
            <span>{section.label}</span>
            <span className="font-mono text-[10px]">{isOpen ? '−' : '+'}</span>
          </button>
        ) : (
          <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-ink-dim">
            {section.label}
          </div>
        )
      )}
      {isOpen && section.items.map(item => {
        const active = item.href === pathname
          || (item.href === '/gw' && pathname === '/gw')
          || (item.href !== '/gw' && item.href !== '/' && pathname?.startsWith(item.href));
        return (
          <Link
            key={item.href}
            href={item.href}
            className={
              active
                ? 'block px-4 py-1.5 text-sm text-ink bg-bg-card border-l-2 border-accent-blue'
                : 'block px-4 py-1.5 text-sm text-ink-muted hover:text-ink hover:bg-bg-card border-l-2 border-transparent hover:border-accent-blue/40'
            }
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
