import { customType, timestamp } from 'drizzle-orm/pg-core';

/** PostgreSQL `bytea` as a Node Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** `timestamptz` read and written as a JS Date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
