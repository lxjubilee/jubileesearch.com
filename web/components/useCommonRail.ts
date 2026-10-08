'use client';

// The shared cross-project rail block, served by JubileeInspire.
//
// Ported from JubileeInspire.com src/hooks/useCommonRail.ts. The list lives in
// one table there and is edited at jubileeinspire.com/admin/rail; every Jubilee
// property reads it from the same public endpoint, so a change made there shows
// here on the next page load with no deploy of this site.
//
// FAILS TO NOTHING. The rail paints with this site's own rows first and the list
// arrives afterwards. A failure — the endpoint down, an offline visitor — yields
// an empty array and the rail shows only its own rows, rather than a hole.
//
// EVERY MOUNT REVALIDATES. The module cache is a first-paint value so a client
// navigation does not flash an empty block; a request still goes out alongside
// it. The endpoint answers no-cache, so the browser does not replay it either.

import { useEffect, useState } from 'react';

const RAIL_API = (process.env.NEXT_PUBLIC_RAIL_API_URL ?? 'https://api.jubileeinspire.com/api/rail-items');

export interface CommonRailItem {
  id: number;
  label: string;
  href: string;
  icon: string;
  iconViewBox: string | null;
  openInNewTab: boolean;
}

let cache: CommonRailItem[] | null = null;
let inFlight: Promise<CommonRailItem[]> | null = null;

function load(): Promise<CommonRailItem[]> {
  if (inFlight) return inFlight;

  inFlight = fetch(RAIL_API, { cache: 'no-store', credentials: 'omit' })
    .then((res) => (res.ok ? res.json() : null))
    .then((r: { items?: unknown } | null) => {
      cache = Array.isArray(r?.items) ? (r.items as CommonRailItem[]) : [];
      return cache;
    })
    // Not cached: a transient failure should not pin an empty block for the
    // life of the tab. The next mount tries again.
    .catch(() => [])
    .finally(() => { inFlight = null; });

  return inFlight;
}

export function useCommonRailItems(): CommonRailItem[] {
  const [items, setItems] = useState<CommonRailItem[]>(cache ?? []);

  useEffect(() => {
    let alive = true;
    load().then((list) => { if (alive) setItems(list); });
    return () => { alive = false; };
  }, []);

  return items;
}
