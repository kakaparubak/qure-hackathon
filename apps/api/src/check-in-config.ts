import { DEFAULT_CHECK_IN_OPTIONS, validateCheckInOptions, type CheckInOptions } from '@qure/core/check-in/policy';
import { ConfigError } from '@qure/core/config';
export function parseCheckInOptions(env:Record<string,string|undefined>):CheckInOptions {
  const options={intervalMinutes:env.CHECK_IN_INTERVAL_MINUTES?.trim() ? Number(env.CHECK_IN_INTERVAL_MINUTES) : DEFAULT_CHECK_IN_OPTIONS.intervalMinutes,
    maxReminders:env.CHECK_IN_MAX_REMINDERS?.trim() ? Number(env.CHECK_IN_MAX_REMINDERS) : DEFAULT_CHECK_IN_OPTIONS.maxReminders};
  try {return validateCheckInOptions(options);} catch {throw new ConfigError('CHECK_IN_INTERVAL_MINUTES must be positive and at most 1440; CHECK_IN_MAX_REMINDERS must be an integer from 1 to 10');}
}
