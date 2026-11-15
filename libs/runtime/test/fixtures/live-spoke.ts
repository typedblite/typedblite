/**
 * A live spoke, as its own OS process: subscribe to the hub, write locally, push, then wait until
 * it has seen the other spoke's work before exiting.
 *
 * Prints the entity ids it saw, so the parent asserts on what actually arrived over the wire rather
 * than on the process merely exiting 0.
 */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';
import { ChangeStreamClient } from '../../src/change-stream-client.js';
import { readKeyedTrackerSchema } from './keyed-tracker-schema.js';

const [, , dbPath, schemaPath, hubUrl, prefix, expectText] = process.argv;
const expect = Number(expectText);

const spoke = new TypeDBLiteInterpreter(dbPath);
spoke.define(readKeyedTrackerSchema(schemaPath));

const client = new ChangeStreamClient(hubUrl, { retryMs: 50 });
const seen = new Set<string>();
const subscription = client.subscribe({
  onChange: (record) => {
    spoke.changeLog.applyRemote({
      entityId: record.entityId,
      rev: record.rev,
      parentRev: record.parentRev,
      deleted: record.deleted,
      state: record.state,
    });
    seen.add(record.entityId);
  },
});

spoke.execute(`insert $s isa project, has project-id "${prefix}" , has project-name "${prefix}";`);
await client.push(spoke.changeLog.since(0));

const deadline = Date.now() + 8000;
while (seen.size < expect && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

await subscription.cancel();
spoke.close();
process.stdout.write(JSON.stringify([...seen].sort()));
process.exit(seen.size >= expect ? 0 : 1);
