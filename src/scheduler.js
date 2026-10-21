import pool from './db.js';
import { startRun, isRunning } from './runner.js';

const TIME_ZONE = 'Australia/Sydney'; // the shop's time zone, not the server's

function sydneyNow() {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date())
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { hour: Number(parts.hour), day: `${parts.year}-${parts.month}-${parts.day}` };
}

// Starts one automatic run per day once the shop's clock reaches AUTO_RUN_HOUR (0-23).
// Off when AUTO_RUN_HOUR is unset. Checks the database, so a restart never causes a second run that day.
export function startScheduler() {
  const hour = process.env.AUTO_RUN_HOUR;
  if (hour === undefined || hour === '' || !Number.isInteger(Number(hour)) || Number(hour) < 0 || Number(hour) > 23) {
    console.log('Scheduler off (AUTO_RUN_HOUR not set)');
    return;
  }
  console.log(`Scheduler on: daily run from ${hour}:00 ${TIME_ZONE}`);

  const tick = async () => {
    try {
      const now = sydneyNow();
      if (now.hour < Number(hour) || isRunning()) return;
      const { rows } = await pool.query(
        `SELECT 1 FROM runs WHERE trigger = 'scheduled'
          AND (created_at AT TIME ZONE $1)::date = $2::date LIMIT 1`,
        [TIME_ZONE, now.day],
      );
      if (rows.length) return;
      console.log('Starting scheduled pricing run');
      await startRun({ trigger: 'scheduled' });
    } catch (error) {
      console.error('Scheduler tick failed:', error.message);
    }
  };
  setInterval(tick, 60 * 1000);
  tick();
}
