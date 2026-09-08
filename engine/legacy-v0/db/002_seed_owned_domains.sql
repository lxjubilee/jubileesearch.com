-- ---------------------------------------------------------------------------
-- JubileeSearch — seed the crawl frontier with the Jubilee family's own sites.
--
-- Source of truth: ops/config/websites-services.json from the 2026-06-14 flash
-- drive backup — the same registry nginx and the Cloudflare tunnel are built
-- from, so this list IS the estate rather than a hand-kept copy of it. The
-- api./dev./dpi. service subdomains are skipped: same content, different
-- environment prefix.
--
-- Owned sites are trusted (trust='owned'), rated family_safe up front, crawled
-- daily (recrawl_hours 24) and capped at 500 pages each until we see how big
-- they actually are. Re-run to pick up newly registered domains.
-- ---------------------------------------------------------------------------

INSERT INTO domains (host, kind, trust, safety_rating, max_pages, recrawl_hours)
VALUES
  ('biblelujah.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('biblewebdomains.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('celestialpaths.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('daisywylder.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('fatherelohim.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('gagedarron.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('gopartygiggles.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('gospelbymusic.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('heidisquest.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('impossibleharvest.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('inspireanimations.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('inspirecodex.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('inspirecontinuum.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('inspirelinux.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('inspireshalom.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('inspirestones.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jixqr.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jsvbible.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubiflix.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubilee-software.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeadspots.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileebibles.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileebooks.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileebrowser.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileechat.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileecircles.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileedaily.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileedonations.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileegoodnews.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeinspire.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeintelligence.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileemessages.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeos.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeparadox.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileepathfinders.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileepocketbible.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileepodcasts.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileereader.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileesearch.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileesermons.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeshekels.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileesmallgroups.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileesnap.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileetablet.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeteams.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileeverse.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileevibes.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('jubileewebsites.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('kjubilee.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('myjubileeradio.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('mytinytiggles.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('onegod.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('spirituallabel.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('talk2characters.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('wwbibleweb.com', 'owned', 'owned', 'family_safe', 500, 24),
  ('yeshuamashiach.com', 'owned', 'owned', 'family_safe', 500, 24)
ON CONFLICT (host) DO UPDATE
  SET kind = EXCLUDED.kind,
      trust = EXCLUDED.trust,
      safety_rating = EXCLUDED.safety_rating,
      updated_at = now();

INSERT INTO schema_migrations (version) VALUES ('002_seed_owned_domains')
  ON CONFLICT (version) DO NOTHING;
