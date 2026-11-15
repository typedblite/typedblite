import { readFileSync } from 'node:fs';

const REPLICATION_KEYS = '\ndefine project owns project-id @key; task owns task-id @key;';

export const readKeyedTrackerSchema = (schemaPath: string): string =>
  readFileSync(schemaPath, 'utf8') + REPLICATION_KEYS;
