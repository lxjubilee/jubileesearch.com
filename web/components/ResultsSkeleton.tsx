import styles from './ResultsSkeleton.module.css';

// What the results area shows while the engine is answering.
//
// Streamed in place of <Results> by the Suspense boundary in search/page.tsx,
// so the reader is already on the results page, with their query in the bar,
// while this stands in. Shaped like the cards it is about to become -- a
// count, the chips, a heading, three results -- so nothing jumps when they
// arrive. Quiet, the way Google's placeholders are: a slow pulse, no spinner.

export default function ResultsSkeleton() {
  return (
    <div className={styles.wrap} role="status" aria-live="polite" aria-label="Searching">
      <div className={`${styles.bar} ${styles.stats}`} />
      <div className={styles.chips}>
        <div className={styles.chip} />
        <div className={styles.chip} />
      </div>
      <div className={`${styles.bar} ${styles.heading}`} />
      {[0, 1, 2].map((i) => (
        <div className={styles.card} key={i}>
          <div className={styles.titleRow}>
            <div className={styles.disc} />
            <div className={`${styles.bar} ${styles.title}`} />
          </div>
          <div className={`${styles.bar} ${styles.url}`} />
          <div className={`${styles.bar} ${styles.line}`} />
          <div className={`${styles.bar} ${styles.lineShort}`} />
        </div>
      ))}
      <span className={styles.srOnly}>Searching…</span>
    </div>
  );
}
