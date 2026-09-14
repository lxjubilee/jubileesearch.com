'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The console's section list.
//
// A client component only because it needs the current path to mark the active
// item; everything it renders is static. The ten entries are §15's ten screens,
// in the order that section lists them, so the console can be checked against
// the specification by reading down the sidebar.
//
// Each entry carries an icon, after JubileeInspire's admin sidebar: a glyph
// beside every label so the list scans by shape as well as by word.

type Icon = React.ReactNode;

const I = {
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  book: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /></>,
  star: <path d="M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.8 6.1 21l1.2-6.5L2.5 9.9l6.6-.9z" />,
  check: <><path d="M20 6L9 17l-5-5" /></>,
  shield: <><path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" /><path d="M9 12l2 2 4-4" /></>,
  block: <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>,
  chart: <><path d="M3 20h18" /><path d="M6 16v-5M11 16V8M16 16v-3M21 16V5" /></>,
  sliders: <><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  tools: <><path d="M14.7 6.3a4 4 0 0 0 5 5L22 9l-3 3-3-3 3-3-1.7-1.7a4 4 0 0 0-2.6 2z" /><path d="M2 22l9-9" /><path d="M14.7 6.3L9 12" /></>,
} satisfies Record<string, Icon>;

const SECTIONS = [
  { href: '/admin', label: 'Dashboard', screen: 1, icon: I.dashboard },
  { href: '/admin/domains', label: 'Domains', screen: 2, icon: I.globe },
  { href: '/admin/lexicon', label: 'Lexicon', screen: 3, icon: I.book },
  { href: '/admin/best-bets', label: 'Best bets', screen: 4, icon: I.star },
  { href: '/admin/candidates', label: 'Whitelist review', screen: 5, icon: I.check },
  { href: '/admin/safety', label: 'Safety queue', screen: 6, icon: I.shield },
  { href: '/admin/blocklists', label: 'Blocklists', screen: 7, icon: I.block },
  { href: '/admin/analytics', label: 'Search analytics', screen: 8, icon: I.chart },
  { href: '/admin/ranking', label: 'Ranking controls', screen: 9, icon: I.sliders },
  { href: '/admin/index-tools', label: 'Index tools', screen: 10, icon: I.tools },
];

export default function AdminNav(
  { safetyQueue, pendingDomains }: { safetyQueue: number; pendingDomains: number },
) {
  const pathname = usePathname();

  return (
    <div className="nav">
      {SECTIONS.map((s) => {
        // /admin must not light up for every child route.
        const active = s.href === '/admin' ? pathname === '/admin' : pathname.startsWith(s.href);
        const count = s.href === '/admin/safety' ? safetyQueue
          : s.href === '/admin/domains' ? pendingDomains
            : 0;

        return (
          <Link
            key={s.href}
            href={s.href}
            className="navItem"
            aria-current={active ? 'page' : undefined}
            title={`Screen ${s.screen}`}
          >
            <svg className="navIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {s.icon}
            </svg>
            <span className="navLabel">{s.label}</span>
            {count > 0 && (
              // Only the safety queue is urgent: §11.3 puts a 48-hour target on
              // it, and a page sits below the fold until it is cleared.
              <span className="navCount" data-urgent={s.href === '/admin/safety'}>{count}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
