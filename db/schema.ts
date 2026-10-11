import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const catalogs = sqliteTable('catalogs', {
  ownerId: text('owner_id').notNull(),
  id: text('id').notNull(),
  dataJson: text('data_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  photoKey: text('photo_key'),
  photoMime: text('photo_mime'),
}, table => [primaryKey({ columns: [table.ownerId, table.id] }), index('catalogs_owner_updated').on(table.ownerId, table.updatedAt)]);

export const providerSettings = sqliteTable('provider_settings', {
  ownerId: text('owner_id').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const requestBudgets = sqliteTable('request_budgets', {
  key: text('key').primaryKey(),
  windowStart: integer('window_start').notNull(),
  count: integer('count').notNull(),
}, table => [index('request_budgets_window').on(table.windowStart)]);
