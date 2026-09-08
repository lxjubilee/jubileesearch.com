-- 020 — seed the domain registry with the Jubilee estate.
--
-- Source of truth: ops/config/websites-services.json from the 2026-06-14 flash
-- drive backup, the same registry nginx and the Cloudflare tunnel are built
-- from. The api./dev./dpi. service subdomains are skipped: same content,
-- different environment prefix. 56 hosts; §18 Phase 1 expects "130+", so this
-- is the registry as it stands and not the whole estate -- the remainder come
-- in through the bulk import in admin screen 2 as they are enumerated.
--
-- Every row lands as status='pending' and zone_a_eligible=FALSE, per §8.1 and
-- §8.2. That is deliberate and is not a placeholder to be tidied away: Zone A
-- is a *guaranteed placement*, so ownership verification is "the only thing
-- standing between the network and an external site claiming premium real
-- estate. Treat it as a security control, not a formality." Promotion happens
-- through `bin/jubilee-search.mjs domains verify`, which records who attested
-- to it and how. It is not a seed's business to grant itself Zone A.
--
-- ingest_mode is 'hybrid': ingest source markdown where a source_root is known,
-- crawl the rest (§9.1 fallback). source_root is NULL on every row because
-- decision D5 -- where the T1 markdown actually lives, and the canonical path
-- structure per domain -- is unanswered and is marked blocking on Phase 2.
-- Policy defaults are the T1 column of §8.3.

INSERT INTO domains (host, tier, status, ingest_mode,
                     crawl_interval_hours, max_pages, max_depth, crawl_delay_ms,
                     owner_org, language_hint, zone_a_eligible)
SELECT host, 'T1', 'pending', 'hybrid',
       24, NULL, 10, 250,
       'Jubilee Software, Inc.', 'en', FALSE
FROM unnest(ARRAY[
  'biblelujah.com','biblewebdomains.com','celestialpaths.com','daisywylder.com',
  'fatherelohim.com','gagedarron.com','gopartygiggles.com','gospelbymusic.com',
  'heidisquest.com','impossibleharvest.com','inspireanimations.com',
  'inspirecodex.com','inspirecontinuum.com','inspirelinux.com','inspireshalom.com',
  'inspirestones.com','jixqr.com','jsvbible.com','jubiflix.com',
  'jubilee-software.com','jubileeadspots.com','jubileebibles.com','jubileebooks.com',
  'jubileebrowser.com','jubileechat.com','jubileecircles.com','jubileedaily.com',
  'jubileedonations.com','jubileegoodnews.com','jubileeinspire.com',
  'jubileeintelligence.com','jubileemessages.com','jubileeos.com',
  'jubileeparadox.com','jubileepathfinders.com','jubileepocketbible.com',
  'jubileepodcasts.com','jubileereader.com','jubileesearch.com','jubileesermons.com',
  'jubileeshekels.com','jubileesmallgroups.com','jubileesnap.com','jubileetablet.com',
  'jubileeteams.com','jubileeverse.com','jubileevibes.com','jubileewebsites.com',
  'kjubilee.com','myjubileeradio.com','mytinytiggles.com','onegod.com',
  'spirituallabel.com','talk2characters.com','wwbibleweb.com','yeshuamashiach.com'
]) AS host
ON CONFLICT (host) DO UPDATE
   SET tier = 'T1',
       owner_org = EXCLUDED.owner_org,
       ingest_mode = EXCLUDED.ingest_mode;
   -- status and zone_a_eligible are pointedly NOT updated: re-running the seed
   -- must never re-grant, nor revoke, a verification decision a human made.
