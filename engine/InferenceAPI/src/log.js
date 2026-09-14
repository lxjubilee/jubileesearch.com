// Structured JSON logs, one object per line.
//
// Deliberately dependency-free. A logging library is a reasonable thing to want
// and a poor thing to require of a service whose whole job is to be liftable to
// another machine without argument.

import { env } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

function emit(level, at, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ level, at, t: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (at, f = {}) => emit('debug', at, f),
  info: (at, f = {}) => emit('info', at, f),
  warn: (at, f = {}) => emit('warn', at, f),
  error: (at, f = {}) => emit('error', at, f),
};

/**
 * Say when a stage missed its §13.10 budget, at warn, with the budget named.
 *
 * THIS IS NOT DECORATION AND MUST NOT BE SOFTENED. The service currently runs on
 * a CPU with no GPU present, and every stage misses its budget by multiples. A
 * service that quietly returns a correct answer three seconds late teaches its
 * callers that three seconds is normal, and the number that would have justified
 * buying hardware never reaches anyone.
 *
 * Set WARN_ON_BUDGET_BREACH=0 only when the noise is genuinely unhelpful — a
 * bulk backfill of 100k chunks does not need 100k warnings — and never as a way
 * of making the logs look better.
 */
export function budget(at, ms, budgetMs, fields = {}) {
  if (!env.warnOnBudgetBreach || !budgetMs || ms <= budgetMs) return;
  emit('warn', at, {
    msg: 'over budget',
    ms: Math.round(ms),
    budget_ms: budgetMs,
    over_by: `${(ms / budgetMs).toFixed(1)}x`,
    ...fields,
  });
}

export default log;
