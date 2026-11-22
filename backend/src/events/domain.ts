import { MongoClient } from 'mongodb';
import { createDomain, type Provider, type StoreEvent } from 'evtstore';
import { createProvider, migrate, type Bookmark } from 'evtstore/provider/mongo';
import { config } from '../config';
import { escrowAgg } from './aggregate';

/**
 * evtstore domain — the escrow lifecycle source of truth, persisted in the
 * same Mongo database (`events` + `bookmarks` collections) as the read models.
 */

let providerPromise: Promise<Provider<import('./types').EscrowEvt>> | null = null;

function getProvider(): Promise<Provider<import('./types').EscrowEvt>> {
  if (!providerPromise) {
    providerPromise = (async () => {
      const client = await MongoClient.connect(config.mongoUri);
      const db = client.db();
      const events = db.collection<StoreEvent<import('./types').EscrowEvt>>('events');
      const bookmarks = db.collection<Bookmark>('bookmarks');
      await migrate(events, bookmarks);
      return createProvider({ limit: 1000, events, bookmarks });
    })();
  }
  return providerPromise;
}

export async function createKoloDomain() {
  const provider = await getProvider();
  return createDomain({ provider }, { escrow: escrowAgg });
}

/** Singleton domain + handler factory used across the app. */
let domainCache: Awaited<ReturnType<typeof createKoloDomain>> | null = null;

export async function getDomain(): Promise<Awaited<ReturnType<typeof createKoloDomain>>> {
  if (!domainCache) domainCache = await createKoloDomain();
  return domainCache;
}
