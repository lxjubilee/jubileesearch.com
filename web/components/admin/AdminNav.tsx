'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The console's section list.
//
// A client component only because it needs the current path to mark the active
// item; everything it renders is static. The ten entries are §15's ten screens,
// in the order that section lists them, so the console can be checked against
// the specification by reading down the sidebar.

const SECTIONS = [
  { href: '/admin', label: 'Dashboard', screen: 1 },
  { href: '/admin/domains', label: 'Domains', screen: 2 },
  { href: '/admin/lexicon', label: 'Lexicon', screen: 3 },
  { href: '/admin/best-bets', label: 'Best bets', screen: 4 },
  { href: '/admin/candidates', label: 'Whitelist review', screen: 5 },
  { href: '/admin/safety', label: 'Safety queue', screen: 6 },
  { href: '/admin/blocklists', label: 'Blocklists', screen: 7 },
  { href: '/admin/analytics', label: 'Search analytics', screen: 8 },
  { href: '/admin/ranking', label: 'Ranking controls', screen: 9 },
  { href: '/admin/index-tools', label: 'Index tools', screen: 10 },
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
            <span>{s.label}</span>
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
